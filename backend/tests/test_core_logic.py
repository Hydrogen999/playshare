"""Tests for the pure logic of the new backend code.

These run without installing FastAPI/SQLAlchemy:  python -m unittest discover -s tests -v
(Database routes and websockets need a full test environment; see README_FIXES.md.)
"""

import base64
import hashlib
import hmac
import importlib.util
import os
import sys
import types
import unittest
from datetime import date

ROOT = os.path.join(os.path.dirname(__file__), "..", "app", "services")


class FakeSettings:
    FLW_SECRET_KEY = "sk_test"
    FLW_BASE_URL = "https://api.flutterwave.com/v3"
    FLW_CALLBACK_URL = "https://site.example/buy/flw-callback"
    VERIFICATION_RETURN_URL = ""
    APP_NAME = "Zuno"
    TURN_URLS = ""
    TURN_SECRET = ""
    TURN_USERNAME = ""
    TURN_CREDENTIAL = ""

    @property
    def turn_list(self):
        return [u.strip() for u in self.TURN_URLS.split(",") if u.strip()]


settings = FakeSettings()
httpx = types.ModuleType("httpx")
httpx.request = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no network in tests"))
sys.modules["httpx"] = httpx
pkg = types.ModuleType("app")
pkg.__path__ = []
cfg = types.ModuleType("app.config")
cfg.settings = settings
sys.modules["app"], sys.modules["app.config"] = pkg, cfg


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


rules = load("verification_rules")
pay = load("verification_payments")
media = load("media")
srules = load("safety_rules")
ice = load("ice")


# ------------------------------------------------------------ verification rules
class Rules(unittest.TestCase):
    def test_flow(self):
        s = rules.next_status(rules.PAYMENT_PENDING, "payment_confirmed")
        self.assertEqual(rules.next_status(s, "approve"), rules.APPROVED)
        with self.assertRaises(rules.InvalidTransition):
            rules.next_status(rules.PAYMENT_PENDING, "approve")
        with self.assertRaises(rules.InvalidTransition):
            rules.next_status(rules.REJECTED, "approve")

    def test_fee(self):
        self.assertTrue(rules.payment_matches_fee(5000, "usd"))
        self.assertFalse(rules.payment_matches_fee(4999, "USD"))
        self.assertFalse(rules.payment_matches_fee(5000, "NGN"))

    def test_form_validation(self):
        good = dict(full_name="Ada Lovelace", username="ada_l", category="influencer",
                    reason="I am a well known creator with a big audience.", website="https://a.co")
        self.assertEqual(rules.validate_application(good).username, "ada_l")
        for bad in ({"website": "javascript:alert(1)"}, {"category": "vip"}, {"reason": "short"}):
            with self.assertRaises(ValueError):
                rules.validate_application({**good, **bad})


# ------------------------------------------------------------ Flutterwave payments
class Payments(unittest.TestCase):
    def test_checkout_request(self):
        calls = []

        def http(method, url, body):
            calls.append((method, url, body))
            return {"status": "success", "data": {"link": "https://checkout.flutterwave.com/pay/x"}}

        ref, link = pay.create_checkout(amount_cents=5000, currency="USD", application_id="12345678-abcd",
                                        user_id="u1", email="a@b.co", name="Ada", http=http)
        _m, url, body = calls[0]
        self.assertTrue(url.endswith("/payments"))
        self.assertEqual((body["amount"], body["currency"], body["tx_ref"]), ("50", "USD", ref))
        self.assertTrue(ref.startswith("vfy_12345678_"))
        self.assertEqual(body["redirect_url"], "https://site.example/verification/done")
        self.assertTrue(link.startswith("https://"))

    def test_refs_unique(self):
        mk = lambda: pay.create_checkout(amount_cents=5000, currency="USD", application_id="abcdefgh", user_id="u",
                                         email="a@b.co", name="x",
                                         http=lambda *a: {"status": "success", "data": {"link": "https://x.y/z"}})[0]
        self.assertNotEqual(mk(), mk())

    def test_bad_checkout_answers(self):
        for resp in ({"status": "error"}, {"status": "success", "data": {"link": "http://insecure"}}, {}):
            with self.assertRaises(pay.PaymentUnavailable):
                pay.create_checkout(amount_cents=5000, currency="USD", application_id="abcdefgh", user_id="u",
                                    email="a@b.co", name="x", http=lambda *a, r=resp: r)

    def test_verify_success_uses_verified_numbers(self):
        v = pay.verify_by_reference("vfy_1", http=lambda *a: {"status": "success", "data": {
            "tx_ref": "vfy_1", "status": "successful", "amount": 50, "currency": "USD", "id": 777}})
        self.assertEqual((v["status"], v["amount_cents"], v["currency"], v["id"]), ("successful", 5000, "USD", "777"))

    def test_verify_unpaid_and_errors(self):
        self.assertIsNone(pay.verify_by_reference("vfy_1", http=lambda *a: {"status": "error", "message": "No transaction was found for this id"}))
        with self.assertRaises(pay.PaymentUnavailable):
            pay.verify_by_reference("vfy_1", http=lambda *a: {"status": "error", "message": "Server busy"})
        # a response about a different transaction must never count
        self.assertIsNone(pay.verify_by_reference("vfy_1", http=lambda *a: {"status": "success", "data": {
            "tx_ref": "someone-else", "status": "successful", "amount": 50, "currency": "USD", "id": 1}}))

    def test_not_configured(self):
        saved, settings.FLW_SECRET_KEY = settings.FLW_SECRET_KEY, ""
        try:
            with self.assertRaises(pay.PaymentUnavailable):
                pay.verify_by_reference("vfy_1")
        finally:
            settings.FLW_SECRET_KEY = saved


# ------------------------------------------------------------ uploads
class Media(unittest.TestCase):
    def test_types_from_bytes_not_names(self):
        self.assertEqual(media.sniff_media(b"\xff\xd8\xff\xe0" + b"0" * 20, "evil.html")[:2], ("image/jpeg", "jpg"))
        self.assertEqual(media.sniff_media(b"\x89PNG\r\n\x1a\n" + b"0" * 20, "x.svg")[:2], ("image/png", "png"))
        self.assertEqual(media.sniff_media(b"RIFF\0\0\0\0WEBPVP8 " + b"0" * 8)[2], "image")
        self.assertEqual(media.sniff_media(b"ID3\x03\0\0\0\0\0\0\0\0")[:2], ("audio/mpeg", "mp3"))

    def test_mp4_family(self):
        mp4 = b"\0\0\0\x18ftypisom\0\0\0\0isomiso2"
        self.assertEqual(media.sniff_media(mp4, "clip.mp4")[2], "video")
        self.assertEqual(media.sniff_media(mp4, "voice.m4a")[2], "audio")      # app voice notes
        self.assertEqual(media.sniff_media(b"\0\0\0\x18ftypM4A \0\0\0\0M4A mp42")[2], "audio")
        self.assertEqual(media.sniff_media(b"\0\0\0\x14ftypqt  \0\0\0\0qt  ")[:2], ("video/quicktime", "mov"))

    def test_dangerous_files_rejected(self):
        for blob in (b"<html><script>alert(1)</script>", b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
                     b"MZ\x90\x00" + b"0" * 20, b"#!/bin/sh\nrm -rf /\n", b"", b"abc"):
            with self.assertRaises(media.BadMedia):
                media.sniff_media(blob, "x.png")

    def test_own_urls_only(self):
        self.assertTrue(media.is_own_media_url("/media/" + "a" * 32 + ".jpg"))
        for bad in ("gift:1000", "challenge:chess:ABC", "https://evil.example/x.png", "javascript:alert(1)", None, "/media/" + "a" * 200):
            self.assertFalse(media.is_own_media_url(bad), bad)

    def test_ranges(self):
        self.assertEqual(media.parse_range("bytes=0-99", 1000), (0, 99))
        self.assertEqual(media.parse_range("bytes=500-", 1000), (500, 999))
        self.assertEqual(media.parse_range("bytes=-100", 1000), (900, 999))
        self.assertEqual(media.parse_range("bytes=900-5000", 1000), (900, 999))
        for bad in (None, "", "bytes=5-2", "bytes=2000-3000", "bytes=a-b", "bytes=0-1,5-6", "items=0-1"):
            self.assertIsNone(media.parse_range(bad, 1000), bad)


# ------------------------------------------------------------ privacy and age
class Privacy(unittest.TestCase):
    def test_allowed(self):
        self.assertTrue(srules.allowed("everyone", False))
        self.assertTrue(srules.allowed("friends", True))
        self.assertFalse(srules.allowed("friends", False))
        self.assertFalse(srules.allowed("nobody", True))
        self.assertFalse(srules.allowed("garbage", True))     # fails closed

    def test_birthday(self):
        today = date(2026, 11, 28)
        self.assertEqual(srules.parse_birthday(11, 28, 2013, today), date(2013, 11, 28))    # exactly 13
        with self.assertRaises(ValueError):
            srules.parse_birthday(11, 29, 2013, today)       # still 12
        with self.assertRaises(ValueError):
            srules.parse_birthday(2, 30, 2000, today)        # not a date
        with self.assertRaises(ValueError):
            srules.parse_birthday(1, 1, 2027, today)         # future
        with self.assertRaises(ValueError):
            srules.parse_birthday(1, 1, 1850, today)


# ------------------------------------------------------------ calls
class Ice(unittest.TestCase):
    def tearDown(self):
        settings.TURN_URLS = settings.TURN_SECRET = settings.TURN_USERNAME = settings.TURN_CREDENTIAL = ""

    def test_stun_only_by_default(self):
        out = ice.build_ice_servers("u1")
        self.assertTrue(out and all("stun" in str(s["urls"]) for s in out))

    def test_time_limited_turn_credentials(self):
        settings.TURN_URLS = "turn:t.example:3478, turns:t.example:5349"
        settings.TURN_SECRET = "s3cret"
        out = ice.build_ice_servers("u1", now=1000.0)
        t = out[-1]
        self.assertEqual(t["urls"], ["turn:t.example:3478", "turns:t.example:5349"])
        self.assertEqual(t["username"], f"{1000 + 6 * 3600}:u1")
        want = base64.b64encode(hmac.new(b"s3cret", t["username"].encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(t["credential"], want)

    def test_static_turn_login(self):
        settings.TURN_URLS, settings.TURN_USERNAME, settings.TURN_CREDENTIAL = "turn:t.example:3478", "me", "pw"
        self.assertEqual(ice.build_ice_servers("u")[-1]["username"], "me")


if __name__ == "__main__":
    unittest.main()

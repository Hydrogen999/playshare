
import random
from dataclasses import dataclass, field

SHAPES = ["circle", "triangle", "cross", "square", "star"]

@dataclass
class WhotCard:
    shape: str
    number: int

    def to_dict(self):
        return {"shape": self.shape, "number": self.number}

@dataclass
class WhotPlayer:
    user_id: str
    hand: list[WhotCard] = field(default_factory=list)

@dataclass
class WhotState:
    players: list[WhotPlayer]
    deck: list[WhotCard]
    discard_pile: list[WhotCard]
    current_player_index: int = 0
    required_shape: str | None = None
    pending_pick: int = 0
    winner_user_id: str | None = None
    turn_number: int = 0

    def current_player(self) -> WhotPlayer:
        return self.players[self.current_player_index]

    def next_turn(self):
        self.current_player_index = (self.current_player_index + 1) % len(self.players)
        self.turn_number += 1

def create_deck() -> list[WhotCard]:
    deck = []
    for shape in SHAPES:
        for num in range(1, 15):
            deck.append(WhotCard(shape, num))
    for _ in range(5):
        deck.append(WhotCard("whot", 20))
    random.shuffle(deck)
    return deck

def new_whot_game(user_ids: list[str]) -> WhotState:
    deck = create_deck()
    players = [WhotPlayer(user_id=uid) for uid in user_ids]
    
    for _ in range(6):
        for p in players:
            p.hand.append(deck.pop(0))

    first_card = deck.pop(0)
    while first_card.shape == "whot":
        deck.append(first_card)
        first_card = deck.pop(0)
        
    discard_pile = [first_card]

    return WhotState(
        players=players,
        deck=deck,
        discard_pile=discard_pile,
    )

def is_playable(card: WhotCard, top_card: WhotCard, required_shape: str | None) -> bool:
    if card.shape == "whot":
        return True
    if required_shape:
        return card.shape == required_shape
    return card.shape == top_card.shape or card.number == top_card.number

def play_card(state: WhotState, user_id: str, card_index: int, chosen_shape: str | None = None) -> dict:
    player = state.current_player()
    if player.user_id != user_id:
        return {"ok": False, "error": "Not your turn"}
    
    if card_index < 0 or card_index >= len(player.hand):
        return {"ok": False, "error": "Invalid card index"}

    card = player.hand[card_index]
    top_card = state.discard_pile[-1]

    if not is_playable(card, top_card, state.required_shape):
        return {"ok": False, "error": "Card does not match shape or number"}

    player.hand.pop(card_index)
    state.discard_pile.append(card)
    state.required_shape = None

    if len(player.hand) == 0:
        state.winner_user_id = user_id
        return {"ok": True, "winner": True}

    extra_turn = False
    if card.number == 1:
        extra_turn = True
    elif card.number == 8:
        state.next_turn()
        extra_turn = True
    elif card.number == 2:
        state.pending_pick += 2
    elif card.number == 14:
        state.pending_pick += 1
    elif card.number == 5:
        state.pending_pick += 3
    elif card.number == 20:
        if chosen_shape in SHAPES:
            state.required_shape = chosen_shape
        else:
            return {"ok": False, "error": "Must choose a valid shape for Whot"}

    if not extra_turn:
        state.next_turn()

    return {"ok": True, "extra_turn": extra_turn}

def draw_card(state: WhotState, user_id: str) -> dict:
    player = state.current_player()
    if player.user_id != user_id:
        return {"ok": False, "error": "Not your turn"}

    if not state.deck:
        if len(state.discard_pile) > 1:
            top = state.discard_pile.pop()
            state.deck = state.discard_pile
            state.discard_pile = [top]
            random.shuffle(state.deck)
        else:
            return {"ok": False, "error": "Deck is empty"}

    drawn = state.deck.pop(0)
    player.hand.append(drawn)

    if state.pending_pick > 0:
        state.pending_pick = 0
        state.next_turn()

    return {"ok": True, "drawn": drawn.to_dict()}

# --- 1. SECURE STATE FOR FRONTEND (Hides other players' hands) ---
def state_to_dict(state: WhotState, viewer_id: str) -> dict:
    return {
        "players": [
            {
                "user_id": p.user_id, 
                "card_count": len(p.hand), 
                "hand": [c.to_dict() for c in p.hand] if p.user_id == viewer_id else []
            }
            for p in state.players
        ],
        "top_card": state.discard_pile[-1].to_dict(),
        "deck_count": len(state.deck),
        "current_user_id": state.current_player().user_id,
        "required_shape": state.required_shape,
        "pending_pick": state.pending_pick,
        "winner_user_id": state.winner_user_id,
        "turn_number": state.turn_number,
    }

# --- 2. FULL STATE FOR DATABASE (Keeps all cards) ---
def serialize_full_state(state: WhotState) -> dict:
    return {
        "players": [
            {"user_id": p.user_id, "hand": [c.to_dict() for c in p.hand]}
            for p in state.players
        ],
        "deck": [c.to_dict() for c in state.deck],
        "discard_pile": [c.to_dict() for c in state.discard_pile],
        "current_player_index": state.current_player_index,
        "required_shape": state.required_shape,
        "pending_pick": state.pending_pick,
        "winner_user_id": state.winner_user_id,
        "turn_number": state.turn_number,
    }

def state_from_dict(data: dict) -> WhotState:
    players = [
        WhotPlayer(
            user_id=p["user_id"], 
            hand=[WhotCard(c["shape"], c["number"]) for c in p["hand"]]
        ) for p in data["players"]
    ]
    
    return WhotState(
        players=players,
        deck=[WhotCard(c["shape"], c["number"]) for c in data["deck"]],
        discard_pile=[WhotCard(c["shape"], c["number"]) for c in data["discard_pile"]],
        current_player_index=data["current_player_index"],
        required_shape=data["required_shape"],
        pending_pick=data["pending_pick"],
        winner_user_id=data["winner_user_id"],
        turn_number=data["turn_number"],
    )

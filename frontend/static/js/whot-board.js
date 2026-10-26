
// Whot Board UI Component

const SHAPE_ICONS = {
  circle: "⭕",
  triangle: "🔺",
  cross: "❌",
  square: "🟦",
  star: "⭐",
  whot: "🃏"
};

const COLOR_STYLES = {
  circle: "text-yellow-400",
  triangle: "text-red-400",
  cross: "text-blue-400",
  square: "text-emerald-400",
  star: "text-purple-400",
  whot: "text-white"
};

export class WhotBoard {
  constructor(container) {
    this.container = container;
    this.myId = null;
    this.state = null;
    this.onPlay = null;
    this.onDraw = null;
    this._build();
  }

  _build() {
    this.container.innerHTML = "";
    this.container.classList.add("whot-root");

    // Status bar
    this.statusBar = document.createElement("div");
    this.statusBar.className = "whot-status-bar";
    this.container.appendChild(this.statusBar);

    // Main table area
    this.table = document.createElement("div");
    this.table.className = "whot-table";
    this.container.appendChild(this.table);

    // Center pile (Deck + Discard)
    this.centerPile = document.createElement("div");
    this.centerPile.className = "whot-center-pile";
    this.table.appendChild(this.centerPile);

    // Other players row
    this.opponentsRow = document.createElement("div");
    this.opponentsRow.className = "whot-opponents";
    this.table.appendChild(this.opponentsRow);

    // My hand
    this.handArea = document.createElement("div");
    this.handArea.className = "whot-hand";
    this.container.appendChild(this.handArea);

    // Message bar
    this.msgBar = document.createElement("div");
    this.msgBar.className = "whot-msg-bar";
    this.container.appendChild(this.msgBar);

    // Shape picker modal (hidden by default)
    this.shapeModal = document.createElement("div");
    this.shapeModal.className = "whot-shape-modal hidden";
    this.shapeModal.innerHTML = `
      <div class="whot-modal-content">
        <h3>Choose a Shape</h3>
        <div class="whot-shape-options">
          ${Object.entries(SHAPE_ICONS).filter(([k]) => k !== 'whot').map(([shape, icon]) => `
            <button data-shape="${shape}" class="whot-shape-btn">${icon}</button>
          `).join("")}
        </div>
      </div>
    `;
    this.container.appendChild(this.shapeModal);

    // Handle shape selection
    this.shapeModal.querySelectorAll(".whot-shape-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const shape = btn.dataset.shape;
        this.shapeModal.classList.add("hidden");
        this._pendingWhotCardIndex = null;
        if (this.onPlay) this.onPlay(this._pendingWhotIndex, shape);
      });
    });
  }

  setIdentity(myId) { this.myId = myId; }
  setCallbacks({ onPlay, onDraw }) {
    this.onPlay = onPlay;
    this.onDraw = onDraw;
  }

  update(state) {
    this.state = state;
    this._render();
  }

  showMessage(text, type = "info") {
    this.msgBar.textContent = text;
    this.msgBar.className = `whot-msg-bar whot-msg-${type}`;
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => {
      this.msgBar.textContent = "";
      this.msgBar.className = "whot-msg-bar";
    }, 3000);
  }

  _render() {
    if (!this.state) return;
    
    // 1. Render Opponents
    this.opponentsRow.innerHTML = "";
    const opponents = this.state.players.filter(p => p.user_id !== this.myId);
    opponents.forEach(p => {
      const isTurn = p.user_id === this.state.current_user_id;
      const div = document.createElement("div");
      div.className = `whot-opponent ${isTurn ? 'active-turn' : ''}`;
      div.innerHTML = `
        <div class="whot-opponent-avatar">👤</div>
        <div class="whot-opponent-cards">🎴 ${p.card_count}</div>
      `;
      this.opponentsRow.appendChild(div);
    });

    // 2. Render Center Pile (Discard + Deck)
    const topCard = this.state.top_card;
    const isMyTurn = this.state.current_user_id === this.myId;
    
    this.centerPile.innerHTML = `
      <div class="whot-deck" id="whotDeckBtn">
        <div class="whot-card-back">🎴</div>
        <div class="whot-deck-count">${this.state.deck_count}</div>
      </div>
      <div class="whot-discard ${this.state.required_shape ? 'required-shape' : ''}">
        <div class="whot-card ${COLOR_STYLES[topCard.shape]}">
          <span class="whot-card-shape">${SHAPE_ICONS[topCard.shape]}</span>
          <span class="whot-card-number">${topCard.number === 20 ? 'W' : topCard.number}</span>
        </div>
        ${this.state.required_shape ? `<div class="whot-required-label">Play ${this.state.required_shape.toUpperCase()}</div>` : ""}
      </div>
    `;

    // Wire deck click
    const deckBtn = this.centerPile.querySelector("#whotDeckBtn");
    if (isMyTurn && !this.state.winner_user_id) {
      deckBtn.style.cursor = "pointer";
      deckBtn.addEventListener("click", () => {
        if (this.onDraw) this.onDraw();
      });
    } else {
      deckBtn.style.opacity = "0.5";
      deckBtn.style.cursor = "not-allowed";
    }

    // 3. Render My Hand
    this.handArea.innerHTML = "";
    const myPlayer = this.state.players.find(p => p.user_id === this.myId);
    
    if (myPlayer && myPlayer.hand) {
      myPlayer.hand.forEach((card, index) => {
        const cardEl = document.createElement("div");
        cardEl.className = `whot-hand-card ${COLOR_STYLES[card.shape]}`;
        if (isMyTurn && !this.state.winner_user_id) cardEl.classList.add("playable");
        
        cardEl.innerHTML = `
          <span class="whot-card-shape">${SHAPE_ICONS[card.shape]}</span>
          <span class="whot-card-number">${card.number === 20 ? 'W' : card.number}</span>
        `;

        cardEl.addEventListener("click", () => {
          if (!isMyTurn || this.state.winner_user_id) return;
          
          if (card.shape === "whot") {
            // Show shape picker
            this._pendingWhotIndex = index;
            this.shapeModal.classList.remove("hidden");
          } else {
            if (this.onPlay) this.onPlay(index, null);
          }
        });

        this.handArea.appendChild(cardEl);
      });
    }

    // 4. Update Status Bar
    if (this.state.winner_user_id) {
      const iWon = this.state.winner_user_id === this.myId;
      this.statusBar.innerHTML = iWon ? `<span class="text-emerald-400 font-bold">🏆 YOU WON!</span>` : `<span class="text-red-400 font-bold">DEFEAT</span>`;
    } else if (isMyTurn) {
      this.statusBar.innerHTML = `<span class="text-emerald-400 font-bold">● YOUR TURN</span>`;
    } else {
      this.statusBar.innerHTML = `<span class="text-slate-400">WAITING FOR OPPONENT…</span>`;
    }
  }
}

// Inject CSS
if (!document.getElementById("whot-style")) {
  const style = document.createElement("style");
  style.id = "whot-style";
  style.textContent = `
  .whot-root { display: flex; flex-direction: column; gap: 15px; align-items: center; width: 100%; max-width: 800px; margin: 0 auto; }
  .whot-status-bar { width: 100%; text-align: center; padding: 10px; background: rgba(5,5,15,0.8); border: 1px solid rgba(6,182,212,0.5); border-radius: 8px; color: #fff; font-family: 'Orbitron', sans-serif; font-weight: 700; text-transform: uppercase; }
  .whot-table { position: relative; width: 100%; min-height: 250px; background: radial-gradient(circle, #1e293b 0%, #0f172a 100%); border-radius: 20px; border: 4px solid #334155; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; box-shadow: inset 0 0 50px rgba(0,0,0,0.8); }
  .whot-center-pile { display: flex; gap: 20px; align-items: center; justify-content: center; margin: 20px 0; }
  .whot-deck { position: relative; display: flex; flex-direction: column; align-items: center; }
  .whot-card-back { width: 60px; height: 90px; background: #7c3aed; border: 2px solid #fff; border-radius: 8px; display: grid; place-items: center; font-size: 30px; box-shadow: 2px 2px 0 #4c1d95, 4px 4px 0 #4c1d95; }
  .whot-deck-count { position: absolute; bottom: -20px; background: #0f172a; padding: 2px 8px; border-radius: 10px; font-size: 12px; border: 1px solid #334155; }
  .whot-discard { position: relative; display: flex; flex-direction: column; align-items: center; }
  .whot-required-label { position: absolute; bottom: -25px; color: #22c55e; font-weight: bold; font-size: 12px; text-transform: uppercase; white-space: nowrap; }
  
  .whot-card { width: 60px; height: 90px; background: #fff; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between; padding: 5px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-weight: 900; }
  .whot-card-shape { font-size: 24px; }
  .whot-card-number { font-size: 20px; text-align: right; align-self: flex-end; }
  
  .whot-opponents { display: flex; gap: 30px; margin-top: 10px; }
  .whot-opponent { display: flex; flex-direction: column; align-items: center; gap: 5px; opacity: 0.6; transition: 0.3s; }
  .whot-opponent.active-turn { opacity: 1; transform: scale(1.1); }
  .whot-opponent-avatar { font-size: 30px; }
  .whot-opponent-cards { background: #0f172a; padding: 4px 10px; border-radius: 12px; font-size: 12px; border: 1px solid #334155; }

  .whot-hand { display: flex; gap: 10px; overflow-x: auto; padding: 20px 10px; width: 100%; justify-content: center; min-height: 140px; }
  .whot-hand-card { width: 70px; height: 105px; background: #fff; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between; padding: 6px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-weight: 900; cursor: default; transition: transform 0.2s; }
  .whot-hand-card.playable { cursor: pointer; border: 2px solid #fbbf24; }
  .whot-hand-card.playable:hover { transform: translateY(-10px); box-shadow: 0 10px 20px rgba(0,0,0,0.6); }
  
  .whot-msg-bar { width: 100%; text-align: center; min-height: 20px; font-weight: bold; }
  .whot-msg-info { color: #94a3b8; } .whot-msg-success { color: #22c55e; } .whot-msg-error { color: #ef4444; } .whot-msg-warn { color: #fbbf24; }

  .whot-shape-modal { position: absolute; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; border-radius: 20px; z-index: 50; backdrop-filter: blur(4px); }
  .whot-shape-modal.hidden { display: none; }
  .whot-modal-content { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; text-align: center; }
  .whot-modal-content h3 { color: #fff; margin-bottom: 15px; font-weight: bold; }
  .whot-shape-options { display: flex; gap: 15px; }
  .whot-shape-btn { font-size: 30px; background: none; border: none; cursor: pointer; transition: transform 0.2s; }
  .whot-shape-btn:hover { transform: scale(1.3); }
  `;
  document.head.appendChild(style);
}

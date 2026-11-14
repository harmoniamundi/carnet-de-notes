// carnet/carnet-history.js — historique d'annulation du Carnet de notes (↶ / ↷, ⌘Z / ⌘⇧Z). Sans DOM.
// Chaque entrée est un instantané du carnet entier (texte JSON) : titre, pages, réglages et page affichée.
// push(avant) : on empile l'état d'AVANT une modification (et le « rétablir » est vidé) ;
// undo(maintenant) / redo(maintenant) : on donne l'état actuel (il passe de l'autre côté) et on reçoit l'état à afficher, ou null s'il n'y en a pas.
// Chargé par index.html via <script src="app/carnet/carnet-history.js"> et testé par carnet-history.test.js.

class CarnetHistory {
    constructor(limit = 200) {
        this.limit = Math.max(1, limit | 0);
        this.undoStack = [];
        this.redoStack = [];
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    push(before) {
        if (typeof before !== 'string') return;
        if (this.undoStack.length && this.undoStack[this.undoStack.length - 1] === before) return; // deux fois le même état : une seule entrée
        this.undoStack.push(before);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack = [];
    }

    undo(current) {
        if (!this.undoStack.length) return null;
        this.redoStack.push(current);
        return this.undoStack.pop();
    }

    redo(current) {
        if (!this.redoStack.length) return null;
        this.undoStack.push(current);
        return this.redoStack.pop();
    }

    clear() {
        this.undoStack = [];
        this.redoStack = [];
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CarnetHistory };

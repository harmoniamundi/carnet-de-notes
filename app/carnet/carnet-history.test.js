'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CarnetHistory } = require('./carnet-history.js');

test('undo / redo restituent les états dans l\'ordre', () => {
    const h = new CarnetHistory();
    assert.equal(h.canUndo, false);
    h.push('A');
    assert.equal(h.canUndo, true);
    assert.equal(h.undo('B'), 'A');
    assert.equal(h.canRedo, true);
    assert.equal(h.redo('A'), 'B');
    assert.equal(h.canRedo, false);
});
test('une nouvelle action efface le « rétablir »', () => {
    const h = new CarnetHistory();
    h.push('A'); h.undo('B');
    h.push('C');
    assert.equal(h.canRedo, false);
});
test('clear vide les deux piles ; undo à vide renvoie null', () => {
    const h = new CarnetHistory();
    h.push('A'); h.clear();
    assert.equal(h.canUndo, false);
    assert.equal(h.undo('X') ?? null, null);
});

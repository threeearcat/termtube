'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

test('clicking a duplicate title sends its original playlist index, including after filtering', () => {
    function element() {
        return {
            value: '', textContent: '', children: [], listeners: {}, classes: new Set(),
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(type, callback) { this.listeners[type] = callback; },
            appendChild(child) { this.children.push(child); },
            set innerHTML(value) { this.children = []; },
            querySelectorAll() { return this.children; },
        };
    }
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, element());
            return elements.get(id);
        },
        createElement: element,
        querySelectorAll: () => [],
        addEventListener() {},
    };
    const selections = [];
    const termtube = {
        getState: async () => null,
        playStreamTrack: selection => selections.push(selection),
        onStateChanged() {}, onTitleChanged() {}, onPlaylistChanged() {},
        onPlaylistsChanged() {}, onStreamTracksChanged() {},
    };
    const context = vm.createContext({ document, window: { termtube } });
    const entry = path.join(__dirname, '..', 'gui', 'renderer.js');
    vm.runInContext(fs.readFileSync(entry, 'utf8'), context, { filename: entry });

    context.updateStreamTrackList(['Other title', { title: 'Unavailable', broken: true }, 'Same title', 'Same title']);
    const search = elements.get('search-input');
    search.value = 'same';
    search.listeners.input();
    const rows = elements.get('playlist').children;
    rows[3].listeners.click();
    rows[2].listeners.click();
    assert.deepEqual(selections, [3, 2]);
    assert.equal(rows[1].listeners.click, undefined, 'unavailable entries remain disabled');
});

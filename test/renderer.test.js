'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function setup() {
    function element() {
        const classes = new Set();
        return {
            value: '', textContent: '', children: [], listeners: {}, classes, style: {}, dataset: {},
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            },
            addEventListener(type, callback) { this.listeners[type] = callback; },
            appendChild(child) { this.children.push(child); },
            scrollIntoView() {}, focus() {},
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
    return { context, elements, selections };
}

test('clicking a duplicate title sends its original playlist index, including after filtering', () => {
    const { context, elements, selections } = setup();
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

test('playlist mode displays the selected track loading, cooldown, and failure states', () => {
    const { context, elements } = setup();
    const state = { mode: 'stream', currentPlaylist: 'calm-jazz', streamLoading: true, pendingStreamTitle: 'Track 301' };
    context.updateState(state);
    const feedback = elements.get('url-feedback');
    assert.equal(elements.get('url-picker').classes.has('hidden'), true);
    assert.equal(feedback.textContent, 'Loading: Track 301');
    context.updateState({ ...state, urlError: 'YouTube requests paused for one hour.' });
    assert.match(feedback.textContent, /paused for one hour/);
    assert.equal(feedback.classes.has('error'), true);
    context.updateState({ ...state, streamLoading: false, urlError: 'Unable to play Track 301.' });
    assert.equal(feedback.textContent, 'Unable to play Track 301.');
    context.updateState({ ...state, streamLoading: false });
    assert.equal(feedback.textContent, '');
    context.updateState({ mode: 'likes', urlError: 'Old streaming error' });
    assert.equal(feedback.textContent, '');
});

'use strict';

const modeBadge = document.getElementById('mode-badge');
const stateIndicator = document.getElementById('state-indicator');
const currentTitle = document.getElementById('current-title');
const btnPlayPause = document.getElementById('btn-playpause');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnNext = document.getElementById('btn-next');
const btnMode = document.getElementById('btn-mode');
const playlistEl = document.getElementById('playlist');
const playlistCount = document.getElementById('playlist-count');
const searchInput = document.getElementById('search-input');
const streamPicker = document.getElementById('stream-picker');
const streamList = document.getElementById('stream-list');
const streamAddBtn = document.getElementById('stream-add-btn');
const streamAddForm = document.getElementById('stream-add-form');
const streamNameInput = document.getElementById('stream-name');
const streamUrlInput = document.getElementById('stream-url');
const streamSaveBtn = document.getElementById('stream-save');
const streamCancelBtn = document.getElementById('stream-cancel');

let cachedPlaylists = [];
let cachedCurrentPlaylist = '';

// Player actions
btnPlayPause.addEventListener('click', () => {
    window.termtube.playerAction('start');
});

btnNext.addEventListener('click', () => {
    window.termtube.playerAction('next');
});

btnMode.addEventListener('click', () => {
    window.termtube.playerAction('mode-change');
});

// Mode selector dropdown
const modeSelector = document.getElementById('mode-selector');
const modeDropdown = document.getElementById('mode-dropdown');

modeBadge.addEventListener('click', () => {
    modeDropdown.classList.toggle('hidden');
});

document.querySelectorAll('.mode-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
        e.stopPropagation();
        window.termtube.setMode(opt.dataset.mode);
        modeDropdown.classList.add('hidden');
    });
});

document.addEventListener('click', (e) => {
    if (!modeSelector.contains(e.target)) {
        modeDropdown.classList.add('hidden');
    }
});

// Stream picker
streamAddBtn.addEventListener('click', () => {
    streamAddForm.classList.remove('hidden');
    streamAddBtn.classList.add('hidden');
    streamNameInput.focus();
});

streamCancelBtn.addEventListener('click', () => {
    streamAddForm.classList.add('hidden');
    streamAddBtn.classList.remove('hidden');
    streamNameInput.value = '';
    streamUrlInput.value = '';
});

streamSaveBtn.addEventListener('click', async () => {
    const name = streamNameInput.value.trim();
    const url = streamUrlInput.value.trim();
    if (!name || !url) return;
    const err = await window.termtube.addPlaylist(name, url);
    if (err === 'not-playlist') {
        streamUrlInput.classList.add('input-error');
        setTimeout(() => streamUrlInput.classList.remove('input-error'), 1500);
        return;
    }
    if (err === 'duplicate') {
        streamNameInput.classList.add('input-error');
        setTimeout(() => streamNameInput.classList.remove('input-error'), 1500);
        return;
    }
    streamNameInput.value = '';
    streamUrlInput.value = '';
    streamAddForm.classList.add('hidden');
    streamAddBtn.classList.remove('hidden');
});

function renderStreamList(playlists, currentPlaylist) {
    streamList.innerHTML = '';
    playlists.forEach(function(pl) {
        const item = document.createElement('div');
        item.className = 'stream-item';
        if (pl.name === currentPlaylist) item.classList.add('active');

        const label = document.createElement('span');
        label.className = 'stream-label';
        label.textContent = pl.name;
        label.addEventListener('click', function() {
            window.termtube.selectPlaylist(pl.name);
        });

        const del = document.createElement('button');
        del.className = 'stream-delete';
        del.textContent = '\u00d7';
        del.title = 'Remove';
        del.addEventListener('click', function(e) {
            e.stopPropagation();
            window.termtube.removePlaylist(pl.name);
        });

        item.appendChild(label);
        item.appendChild(del);
        streamList.appendChild(item);
    });
}

function updateState(state) {
    if (!state) return;

    // Mode
    modeBadge.textContent = state.mode === 'stream' ? state.currentPlaylist || 'stream' : state.mode;
    document.querySelectorAll('.mode-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.mode === state.mode);
    });

    // Stream picker visibility
    streamPicker.classList.toggle('hidden', state.mode !== 'stream');

    // Update cached playlists
    if (state.playlists) cachedPlaylists = state.playlists;
    if (state.currentPlaylist !== undefined) cachedCurrentPlaylist = state.currentPlaylist;
    renderStreamList(cachedPlaylists, cachedCurrentPlaylist);

    // Play state indicator
    stateIndicator.className = '';
    if (state.state === 'play') {
        stateIndicator.classList.add('playing');
        iconPlay.style.display = 'none';
        iconPause.style.display = '';
    } else if (state.state === 'pause') {
        stateIndicator.classList.add('paused');
        iconPlay.style.display = '';
        iconPause.style.display = 'none';
    } else {
        iconPlay.style.display = '';
        iconPause.style.display = 'none';
    }

    // Title
    if (state.title) {
        currentTitle.textContent = state.title;
    }

    // Playlist
    if (state.mode === 'stream') {
        updateStreamTrackList(state.streamTracks || []);
    } else if (state.videos) {
        updatePlaylist(state.videos);
    }
}

function updateTitle(title) {
    currentTitle.textContent = title || 'Not playing';
    highlightActiveTrack(title);
}

function applySearchFilter() {
    const query = searchInput.value.toLowerCase();
    playlistEl.querySelectorAll('.playlist-item').forEach(function(item) {
        item.classList.toggle('filter-hidden', query !== '' && !item.textContent.toLowerCase().includes(query));
    });
}

function updatePlaylist(videos) {
    playlistCount.textContent = videos.length;
    playlistEl.innerHTML = '';
    videos.forEach(function(video) {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.textContent = video.title;
        item.title = video.title;
        item.dataset.filename = video.filename;
        item.addEventListener('click', function() {
            window.termtube.playTrack(video.filename);
        });
        playlistEl.appendChild(item);
    });
    applySearchFilter();
}

searchInput.addEventListener('input', applySearchFilter);
searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        searchInput.value = '';
        applySearchFilter();
        searchInput.blur();
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput.focus();
    }
});

function updateStreamTrackList(tracks) {
    playlistCount.textContent = tracks.length;
    playlistEl.innerHTML = '';
    tracks.forEach(function(title) {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.textContent = title;
        item.title = title;
        playlistEl.appendChild(item);
    });
    applySearchFilter();
}

function highlightActiveTrack(title) {
    const items = playlistEl.querySelectorAll('.playlist-item');
    items.forEach(function(item) {
        if (item.textContent === title) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
            item.classList.remove('active');
        }
    });
}

// Listen for events from main process
window.termtube.onStateChanged(updateState);
window.termtube.onTitleChanged(updateTitle);
window.termtube.onPlaylistChanged(updatePlaylist);
window.termtube.onPlaylistsChanged(function(playlists) {
    cachedPlaylists = playlists;
    renderStreamList(cachedPlaylists, cachedCurrentPlaylist);
});
window.termtube.onStreamTracksChanged(updateStreamTrackList);

// Initialize
window.termtube.getState().then(updateState);

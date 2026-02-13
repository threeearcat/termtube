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

function updateState(state) {
    if (!state) return;

    // Mode
    modeBadge.textContent = state.mode;
    document.querySelectorAll('.mode-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.mode === state.mode);
    });

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
    if (state.videos) {
        updatePlaylist(state.videos);
    }
}

function updateTitle(title) {
    currentTitle.textContent = title || 'Not playing';
    highlightActiveTrack(title);
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

// Initialize
window.termtube.getState().then(updateState);

// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

const {ipcRenderer} = require('electron');

function createElem(video) {
    var entry = document.createElement('li');
    var title = document.createTextNode(video)
    entry.appendChild(title);
    return entry;
}

function listVideo(video) {
    var videos = document.getElementById('videos')
    var elem = createElem(video);
    videos.appendChild(elem);
}

ipcRenderer.on('video', (event, arg) => {
    listVideo(arg);
});

ipcRenderer.send('req');

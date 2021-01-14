// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

const {ipcRenderer} = require('electron');

function createElem(videojson) {
    var entry = document.createElement('li');
    const video = JSON.parse(videojson);
    const title = document.createTextNode(video.title)
    const id = video.id

    entry.appendChild(title);
    entry.addEventListener('click', function(event) {
        ipcRenderer.send('click', videojson);
    });
    entry.setAttribute('id', id);
    return entry;
}

function listVideo(videojson) {
    var videos = document.getElementById('videos')
    var elem = createElem(videojson);
    videos.appendChild(elem);
}

ipcRenderer.on('video', (event, arg) => {
    listVideo(arg);
});

ipcRenderer.send('req');

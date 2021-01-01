// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

const alertOnlineStatus = () => {
    window.alert(navigator.onLine ? 'online' : 'offline')
}

window.addEventListener('online', alertOnlineStatus)



const {ipcRenderer} = require('electron');
ipcRenderer.on('ping', (event, message) => {
    window.alaert(message);
    elem.dispatchEvent(new Event('online'));
})

ipcRenderer.on('hi', () => window.alert('hi'));
ipcRenderer.send('something');

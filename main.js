'use strict'

const auth = require(__dirname + "/auth.js");

function auth_callback(auth) {
		console.log("auth done");
}

auth.authorize(auth_callback);

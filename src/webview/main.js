'use strict';
const { formPage } = require('./form');
const { keyPage } = require('./key');
const { consolePage, serverPage, pubsubPage, memoryPage } = require('./pages');

const app = document.getElementById('app');
const page = document.body.dataset.page;
const run = { form: formPage, key: keyPage, console: consolePage, server: serverPage, pubsub: pubsubPage, memory: memoryPage }[page];
if (run) Promise.resolve(run(app)).catch((e) => { app.textContent = `Error: ${e.message}`; });

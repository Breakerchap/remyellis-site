'use strict';

const path = require('node:path');

process.env.NOTES_HOST ||= '127.0.0.1';
process.env.NOTES_PORT ||= '8790';
process.env.NOTES_ADMIN_PASSWORD = process.env.NOTES_DEV_PASSWORD || 'dev';
process.env.NOTES_SECURE_COOKIE ||= '0';
process.env.NOTES_SERVE_STATIC ||= '1';
process.env.NOTES_DATA_PATH ||= path.join(__dirname, 'data', 'notes.dev.json');

console.log('Local Notes development mode');
console.log(`Admin password: ${process.env.NOTES_ADMIN_PASSWORD}`);
console.log('This development password is only for localhost testing.');

require('./notes-server.js');

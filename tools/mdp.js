// Usage : node tools/mdp.js "MonMotDePasse" > www/config.js
const c = require('crypto'), pw = process.argv[2];
if (!pw || pw.length < 4) { console.error('Donnez un mot de passe de 4 caractères minimum.'); process.exit(1); }
const sha = s => c.createHash('sha256').update(s, 'utf8').digest('hex');
const salt = c.randomBytes(12).toString('hex');
let h = sha(salt + ':' + pw); for (let i = 0; i < 3000; i++) h = sha(h + salt + pw);
console.log('// Mot de passe administrateur pré-installé (prix CSPS / public et DRD)');
console.log('window.ADMIN_PW = ' + JSON.stringify({ salt, hash: h }) + ';');

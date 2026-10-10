'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { createGunzip } = require('node:zlib');
const { Prisma } = require('@prisma/client');
const fields = ['id', 'idBrand', 'idProduct', 'idSystem', 'idConfig', 'idCrystal', 'costoA', 'costoB', 'costoC'];

function parseTuples(sql) {
  const rows = [];
  let row = null, token = '', quoted = false, escaped = false;
  for (const char of sql) {
    if (escaped) { token += char; escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === "'") { quoted = !quoted; continue; }
    if (quoted) { token += char; continue; }
    if (char === '(') {
      if (row) throw new Error('Unsupported expression in pricing rule backup.');
      row = []; token = '';
    } else if (char === ',') {
      if (row) { row.push(token.trim()); token = ''; }
    } else if (char === ')') {
      if (!row) throw new Error('Malformed pricing rule backup.');
      row.push(token.trim()); rows.push(row); row = null; token = '';
    } else if (row) token += char;
    else if (!/[\s;]/.test(char)) throw new Error('Unsupported pricing rule backup syntax.');
  }
  if (row || quoted || escaped) throw new Error('Incomplete pricing rule backup INSERT.');
  return rows;
}

async function validateBackup(file, expectedRules, database) {
  const info = fs.statSync(file);
  if (!info.isFile() || !info.size) throw new Error('A readable full SQL gzip backup is required.');
  const digest = createHash('sha256');
  const source = fs.createReadStream(file);
  source.on('data', chunk => digest.update(chunk));
  const unzip = source.pipe(createGunzip());
  source.on('error', error => unzip.destroy(error));
  const lines = readline.createInterface({ input: unzip, crlfDelay: Infinity });
  const expected = new Map(expectedRules.map(rule => [String(rule.id), rule]));
  const found = new Set();
  let columns = [], inTable = false, complete = false, matchedDatabase = false, sawTable = false;
  // readline does not forward source stream errors; close it and retain the error.
  let streamError;
  unzip.on('error', error => { streamError = error; lines.close(); });
  try {
  for await (const line of lines) {
    if (/^-- Host:/.test(line)) {
      const header = line.match(/\bDatabase:\s*(\S+)/);
      if (header && header[1] === database) matchedDatabase = true;
    }
    if (/^CREATE TABLE `pricing_rules`/i.test(line)) { columns = []; inTable = true; sawTable = true; continue; }
    if (inTable) {
      const column = line.match(/^\s+`([^`]+)`\s+/);
      if (column) columns.push(column[1]);
      if (/^\)/.test(line)) inTable = false;
    }
    if (/^INSERT INTO `pricing_rules`/i.test(line)) {
      const insert = line.match(/^INSERT INTO `pricing_rules` VALUES (.*);\s*$/i);
      if (!insert || fields.some(field => !columns.includes(field))) throw new Error('Unsupported pricing_rules structure in backup.');
      for (const values of parseTuples(insert[1])) {
        if (values.length !== columns.length) throw new Error('Backup pricing rule column count mismatch.');
        const record = Object.fromEntries(columns.map((column, i) => [column, values[i]]));
        const planned = expected.get(record.id);
        if (!planned) continue;
        if (found.has(record.id)) throw new Error('Backup has a duplicate affected pricing rule.');
        for (const field of fields) {
          if (!new Prisma.Decimal(record[field]).eq(String(planned[field]))) throw new Error(`Backup does not match planned pricing rule ${record.id}, field ${field}. Create a fresh backup.`);
        }
        found.add(record.id);
      }
    }
    if (line.startsWith('-- Dump completed on ')) complete = true;
  }
  } catch (error) {
    if (streamError || error.code?.startsWith('Z_')) throw new Error('Backup gzip integrity check failed.');
    throw error;
  } finally {
    lines.close();
    unzip.destroy();
    source.destroy();
  }
  if (streamError) throw new Error('Backup gzip integrity check failed.');
  if (!complete || !sawTable || !matchedDatabase) throw new Error('Backup is not a complete dump of the expected database.');
  if (found.size !== expected.size) throw new Error('Backup is missing one or more affected pricing rules.');
  return { file: path.resolve(file), bytes: info.size, sha256Compressed: digest.digest('hex'), verifiedDirectRules: found.size };
}

module.exports = { validateBackup, parseTuples };

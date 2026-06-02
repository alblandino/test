const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SQLITE_PATH = path.join(DATA_DIR, 'database.sqlite');
const JSON_PATH = path.join(DATA_DIR, 'database.json');

let dbEngine = null; // 'sqlite' or 'json'
let sqliteDb = null;
let jsonDb = {
  notices: [],
  notice_details: [],
  notice_schedules: [],
  process_api_data: [],
  notice_documents: [],
  notice_items: [],
  notice_awards: [],
  notice_award_reports: [],
  notice_awardees: [],
  scrapes: [],
  suppliers: []
};

// JSON Database Helper functions
function saveJsonToFile() {
  fs.writeFileSync(JSON_PATH, JSON.stringify(jsonDb, null, 2), 'utf-8');
}

function loadJsonFromFile() {
  if (fs.existsSync(JSON_PATH)) {
    try {
      const content = fs.readFileSync(JSON_PATH, 'utf-8');
      jsonDb = JSON.parse(content);
    } catch (e) {
      console.error('Error loading JSON DB, initializing empty:', e);
    }
  } else {
    saveJsonToFile();
  }
}

// Check SQLite availability and initialize
try {
  const sqlite3 = require('sqlite3').verbose();
  sqliteDb = new sqlite3.Database(SQLITE_PATH, (err) => {
    if (err) {
      console.error('Could not connect to SQLite database. Falling back to JSON.', err);
      setupJsonEngine();
    } else {
      console.log('Connected to SQLite database at', SQLITE_PATH);
      setupSqliteEngine();
    }
  });
} catch (e) {
  console.warn('SQLite3 module not available or failed to load. Falling back to JSON database.', e.message);
  setupJsonEngine();
}

function setupJsonEngine() {
  dbEngine = 'json';
  loadJsonFromFile();
  console.log('JSON Database Engine initialized successfully at', JSON_PATH);
}

function setupSqliteEngine() {
  dbEngine = 'sqlite';
  
  // Create tables if they do not exist
  sqliteDb.serialize(() => {
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notices (
        uid TEXT PRIMARY KEY,
        country TEXT,
        buyer_name TEXT,
        reference TEXT,
        description TEXT,
        phase TEXT,
        publish_date TEXT,
        submission_date TEXT,
        base_price TEXT,
        base_price_num REAL,
        state TEXT,
        scraped_at TEXT,
        detail_scraped INTEGER DEFAULT 0
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_details (
        notice_uid TEXT PRIMARY KEY,
        procedure_type TEXT,
        type_of_contract TEXT,
        subtype_of_contract TEXT,
        place_of_work TEXT,
        budget_total_value REAL,
        budget_currency TEXT,
        expenditure_objective TEXT,
        source_of_funds TEXT,
        manual_integration TEXT,
        snip TEXT,
        snip_code TEXT,
        FOREIGN KEY(notice_uid) REFERENCES notices(uid)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_uid TEXT,
        label TEXT,
        date_str TEXT,
        FOREIGN KEY(notice_uid) REFERENCES notices(uid)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS process_api_data (
        notice_uid TEXT PRIMARY KEY,
        reference TEXT,
        dirigido_mipymes TEXT,
        dirigido_mipymes_mujeres TEXT,
        proceso_lotificado TEXT,
        decreto_presidencial TEXT,
        resolucion_maxima_autoridad TEXT,
        organismo_financiero_externo TEXT,
        marco_decreto_3122 TEXT,
        compra_verde TEXT,
        compra_conjunta TEXT,
        accepted_bids_format INTEGER,
        apropiacion_presupuestaria TEXT,
        FOREIGN KEY(notice_uid) REFERENCES notices(uid)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS scrapes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT,
        ended_at TEXT,
        status TEXT,
        pages_requested INTEGER,
        notices_found INTEGER DEFAULT 0,
        notices_processed INTEGER DEFAULT 0,
        logs TEXT DEFAULT ''
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_uid TEXT,
        name TEXT,
        type TEXT,
        download_url TEXT,
        FOREIGN KEY(notice_uid) REFERENCES notices(uid)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notice_uid TEXT,
        item_index TEXT,
        category TEXT,
        account TEXT,
        description TEXT,
        quantity REAL,
        unit TEXT,
        unit_price REAL,
        total_price REAL,
        FOREIGN KEY(notice_uid) REFERENCES notices(uid)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_awards (
        award_id TEXT PRIMARY KEY,
        notice_uid TEXT,
        award_date TEXT,
        award_value TEXT,
        award_value_num REAL,
        FOREIGN KEY(notice_uid) REFERENCES notices(uid)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_award_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        award_id TEXT,
        name TEXT,
        date TEXT,
        download_url TEXT,
        FOREIGN KEY(award_id) REFERENCES notice_awards(award_id)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS notice_awardees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        award_id TEXT,
        name TEXT,
        value TEXT,
        value_num REAL,
        FOREIGN KEY(award_id) REFERENCES notice_awards(award_id)
      )
    `);

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS suppliers (
        rpe TEXT PRIMARY KEY,
        razon_social TEXT,
        numero_documento TEXT,
        tipo_documento TEXT,
        estado_rpe TEXT,
        genero TEXT,
        tipo_persona TEXT,
        forma_juridica TEXT,
        mipyme TEXT,
        certificado_micm TEXT,
        clasificacion TEXT,
        clasificacion_empresarial TEXT,
        provincia TEXT,
        municipio TEXT,
        correo TEXT,
        telefono TEXT,
        direccion TEXT,
        contacto TEXT,
        observacion TEXT
      )
    `);

    sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_suppliers_doc ON suppliers (numero_documento)`);

    // Create indices for faster queries
    sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_notices_pub_date ON notices (publish_date)`);
    sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_notices_base_price ON notices (base_price_num)`);
  });
}

// Database API implementation
const db = {
  getEngine() {
    return dbEngine;
  },

  // Save a list of notices (insert or replace)
  saveNotice(notice) {
    const scraped_at = new Date().toISOString();
    
    // Parse price to numeric value for filtering
    let base_price_num = 0;
    if (notice.basePrice) {
      const match = notice.basePrice.replace(/,/g, '').match(/([\d\.]+)/);
      if (match) {
        base_price_num = parseFloat(match[1]);
      }
    }

    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.run(
          `INSERT OR REPLACE INTO notices (uid, country, buyer_name, reference, description, phase, publish_date, submission_date, base_price, base_price_num, state, scraped_at, detail_scraped)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT CASE WHEN state = ? AND phase = ? THEN detail_scraped ELSE 0 END FROM notices WHERE uid = ?), 0))`,
          [
            notice.uid,
            notice.country,
            notice.buyerName,
            notice.reference,
            notice.description,
            notice.phase,
            notice.publishDate,
            notice.submissionDate,
            notice.basePrice,
            base_price_num,
            notice.state,
            scraped_at,
            notice.state,
            notice.phase,
            notice.uid
          ],
          function(err) {
            if (err) reject(err);
            else resolve(this.changes);
          }
        );
      });
    } else {
      const idx = jsonDb.notices.findIndex(n => n.uid === notice.uid);
      const existing = idx >= 0 ? jsonDb.notices[idx] : null;
      let detail_scraped = existing ? existing.detail_scraped : 0;
      if (existing && (existing.state !== notice.state || existing.phase !== notice.phase)) {
        detail_scraped = 0;
      }
      
      const newNotice = {
        uid: notice.uid,
        country: notice.country,
        buyer_name: notice.buyerName,
        reference: notice.reference,
        description: notice.description,
        phase: notice.phase,
        publish_date: notice.publishDate,
        submission_date: notice.submissionDate,
        base_price: notice.basePrice,
        base_price_num,
        state: notice.state,
        scraped_at,
        detail_scraped
      };

      if (idx >= 0) {
        jsonDb.notices[idx] = newNotice;
      } else {
        jsonDb.notices.push(newNotice);
      }
      saveJsonToFile();
      return Promise.resolve(1);
    }
  },

  // Save notice details
  saveNoticeDetails(details) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          sqliteDb.run(
            `INSERT OR REPLACE INTO notice_details (notice_uid, procedure_type, type_of_contract, subtype_of_contract, place_of_work, budget_total_value, budget_currency, expenditure_objective, source_of_funds, manual_integration, snip, snip_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              details.noticeUID,
              details.procedureType,
              details.typeOfContract,
              details.subtypeOfContract,
              details.placeOfWork,
              details.budgetTotalValue,
              details.budgetCurrency,
              details.expenditureObjective,
              details.sourceOfFunds,
              details.manualIntegration,
              details.snip,
              details.snipCode
            ],
            (err) => {
              if (err) return reject(err);
            }
          );

          sqliteDb.run(
            `UPDATE notices SET detail_scraped = 1 WHERE uid = ?`,
            [details.noticeUID],
            function(err) {
              if (err) reject(err);
              else resolve(this.changes);
            }
          );
        });
      });
    } else {
      const idx = jsonDb.notice_details.findIndex(d => d.notice_uid === details.noticeUID);
      const newDetails = {
        notice_uid: details.noticeUID,
        procedure_type: details.procedureType,
        type_of_contract: details.typeOfContract,
        subtype_of_contract: details.subtypeOfContract,
        place_of_work: details.placeOfWork,
        budget_total_value: details.budgetTotalValue,
        budget_currency: details.budgetCurrency,
        expenditure_objective: details.expenditureObjective,
        source_of_funds: details.sourceOfFunds,
        manual_integration: details.manualIntegration,
        snip: details.snip,
        snip_code: details.snipCode
      };

      if (idx >= 0) {
        jsonDb.notice_details[idx] = newDetails;
      } else {
        jsonDb.notice_details.push(newDetails);
      }

      const notice = jsonDb.notices.find(n => n.uid === details.noticeUID);
      if (notice) {
        notice.detail_scraped = 1;
      }
      saveJsonToFile();
      return Promise.resolve(1);
    }
  },

  // Save schedules timeline
  saveNoticeSchedules(noticeUID, schedules) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          // Clear old schedules first
          sqliteDb.run(`DELETE FROM notice_schedules WHERE notice_uid = ?`, [noticeUID], (err) => {
            if (err) return reject(err);
          });

          if (!schedules || schedules.length === 0) {
            return resolve(0);
          }

          const stmt = sqliteDb.prepare(`INSERT INTO notice_schedules (notice_uid, label, date_str) VALUES (?, ?, ?)`);
          schedules.forEach(s => {
            stmt.run([noticeUID, s.label, s.dateStr]);
          });
          stmt.finalize((err) => {
            if (err) reject(err);
            else resolve(schedules.length);
          });
        });
      });
    } else {
      // Clear old schedules
      jsonDb.notice_schedules = jsonDb.notice_schedules.filter(s => s.notice_uid !== noticeUID);
      schedules.forEach(s => {
        jsonDb.notice_schedules.push({
          notice_uid: noticeUID,
          label: s.label,
          date_str: s.dateStr
        });
      });
      saveJsonToFile();
      return Promise.resolve(schedules.length);
    }
  },

  // Save notice documents
  saveNoticeDocuments(noticeUID, documents) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          sqliteDb.run(`DELETE FROM notice_documents WHERE notice_uid = ?`, [noticeUID], (err) => {
            if (err) return reject(err);
          });
          if (!documents || documents.length === 0) {
            return resolve(0);
          }
          const stmt = sqliteDb.prepare(`INSERT INTO notice_documents (notice_uid, name, type, download_url) VALUES (?, ?, ?, ?)`);
          documents.forEach(doc => {
            stmt.run([noticeUID, doc.name, doc.type, doc.downloadUrl]);
          });
          stmt.finalize((err) => {
            if (err) reject(err);
            else resolve(documents.length);
          });
        });
      });
    } else {
      jsonDb.notice_documents = jsonDb.notice_documents.filter(d => d.notice_uid !== noticeUID);
      documents.forEach(doc => {
        jsonDb.notice_documents.push({
          notice_uid: noticeUID,
          name: doc.name,
          type: doc.type,
          download_url: doc.downloadUrl
        });
      });
      saveJsonToFile();
      return Promise.resolve(documents.length);
    }
  },

  // Save notice items (Questionnaire / list of articles)
  saveNoticeItems(noticeUID, items) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          sqliteDb.run(`DELETE FROM notice_items WHERE notice_uid = ?`, [noticeUID], (err) => {
            if (err) return reject(err);
          });
          if (!items || items.length === 0) {
            return resolve(0);
          }
          const stmt = sqliteDb.prepare(`INSERT INTO notice_items (notice_uid, item_index, category, account, description, quantity, unit, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          items.forEach(itm => {
            stmt.run([
              noticeUID,
              itm.index,
              itm.category,
              itm.account,
              itm.description,
              itm.quantity,
              itm.unit,
              itm.unitPrice,
              itm.totalPrice
            ]);
          });
          stmt.finalize((err) => {
            if (err) reject(err);
            else resolve(items.length);
          });
        });
      });
    } else {
      jsonDb.notice_items = jsonDb.notice_items.filter(i => i.notice_uid !== noticeUID);
      items.forEach(itm => {
        jsonDb.notice_items.push({
          notice_uid: noticeUID,
          item_index: itm.index,
          category: itm.category,
          account: itm.account,
          description: itm.description,
          quantity: itm.quantity,
          unit: itm.unit,
          unit_price: itm.unitPrice,
          total_price: itm.totalPrice
        });
      });
      saveJsonToFile();
      return Promise.resolve(items.length);
    }
  },

  // Save notice awards resolution details
  saveNoticeAwards(noticeUID, awards) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          // Find all awards for this notice first and delete them, reports, and awardees
          sqliteDb.all(`SELECT award_id FROM notice_awards WHERE notice_uid = ?`, [noticeUID], (err, rows) => {
            if (err) return reject(err);
            const awardIds = (rows || []).map(r => r.award_id);
            
            const proceedWithDeletesAndInserts = () => {
              sqliteDb.run(`DELETE FROM notice_awards WHERE notice_uid = ?`, [noticeUID], (err) => {
                if (err) return reject(err);

                if (!awards || awards.length === 0) {
                  return resolve(0);
                }

                const insertAward = sqliteDb.prepare(`INSERT OR REPLACE INTO notice_awards (award_id, notice_uid, award_date, award_value, award_value_num) VALUES (?, ?, ?, ?, ?)`);
                const insertReport = sqliteDb.prepare(`INSERT INTO notice_award_reports (award_id, name, date, download_url) VALUES (?, ?, ?, ?)`);
                const insertAwardee = sqliteDb.prepare(`INSERT INTO notice_awardees (award_id, name, value, value_num) VALUES (?, ?, ?, ?)`);

                awards.forEach(aw => {
                  let valueNum = 0;
                  if (aw.value) {
                    const match = aw.value.replace(/,/g, '').match(/([\d\.]+)/);
                    if (match) valueNum = parseFloat(match[1]);
                  }
                  insertAward.run([aw.id, noticeUID, aw.date, aw.value, valueNum]);

                  (aw.reports || []).forEach(rep => {
                    insertReport.run([aw.id, rep.name, rep.date, rep.downloadUrl]);
                  });

                  (aw.awardees || []).forEach(ee => {
                    let eeNum = 0;
                    if (ee.value) {
                      const match = ee.value.replace(/,/g, '').match(/([\d\.]+)/);
                      if (match) eeNum = parseFloat(match[1]);
                    }
                    insertAwardee.run([aw.id, ee.name, ee.value, eeNum]);
                  });
                });

                insertAward.finalize();
                insertReport.finalize();
                insertAwardee.finalize((err) => {
                  if (err) reject(err);
                  else resolve(awards.length);
                });
              });
            };

            if (awardIds.length > 0) {
              const placeholders = awardIds.map(() => '?').join(',');
              sqliteDb.run(`DELETE FROM notice_award_reports WHERE award_id IN (${placeholders})`, awardIds, () => {
                sqliteDb.run(`DELETE FROM notice_awardees WHERE award_id IN (${placeholders})`, awardIds, () => {
                  proceedWithDeletesAndInserts();
                });
              });
            } else {
              proceedWithDeletesAndInserts();
            }
          });
        });
      });
    } else {
      const oldAwards = jsonDb.notice_awards.filter(a => a.notice_uid === noticeUID);
      const oldAwardIds = oldAwards.map(a => a.award_id);

      jsonDb.notice_awards = jsonDb.notice_awards.filter(a => a.notice_uid !== noticeUID);
      jsonDb.notice_award_reports = jsonDb.notice_award_reports.filter(r => !oldAwardIds.includes(r.award_id));
      jsonDb.notice_awardees = jsonDb.notice_awardees.filter(e => !oldAwardIds.includes(e.award_id));

      awards.forEach(aw => {
        let valueNum = 0;
        if (aw.value) {
          const match = aw.value.replace(/,/g, '').match(/([\d\.]+)/);
          if (match) valueNum = parseFloat(match[1]);
        }
        jsonDb.notice_awards.push({
          award_id: aw.id,
          notice_uid: noticeUID,
          award_date: aw.date,
          award_value: aw.value,
          award_value_num: valueNum
        });

        (aw.reports || []).forEach(rep => {
          jsonDb.notice_award_reports.push({
            award_id: aw.id,
            name: rep.name,
            date: rep.date,
            download_url: rep.downloadUrl
          });
        });

        (aw.awardees || []).forEach(ee => {
          let eeNum = 0;
          if (ee.value) {
            const match = ee.value.replace(/,/g, '').match(/([\d\.]+)/);
            if (match) eeNum = parseFloat(match[1]);
          }
          jsonDb.notice_awardees.push({
            award_id: aw.id,
            name: ee.name,
            value: ee.value,
            value_num: eeNum
          });
        });
      });

      saveJsonToFile();
      return Promise.resolve(awards.length);
    }
  },

  // Save process API data
  saveProcessApiData(apiData) {
    const certString = apiData.apropiacionPresupuestaria ? JSON.stringify(apiData.apropiacionPresupuestaria) : '[]';
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.run(
          `INSERT OR REPLACE INTO process_api_data (notice_uid, reference, dirigido_mipymes, dirigido_mipymes_mujeres, proceso_lotificado, decreto_presidencial, resolucion_maxima_autoridad, organismo_financiero_externo, marco_decreto_3122, compra_verde, compra_conjunta, accepted_bids_format, apropiacion_presupuestaria)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            apiData.noticeUID,
            apiData.reference,
            apiData.dirigidoMipymes,
            apiData.dirigidoMipymesMujeres,
            apiData.procesoLotificado,
            apiData.decretoPresidencial,
            apiData.resolucionMaximaAutoridad,
            apiData.organismoFinancieroExterno,
            apiData.marcoDecreto3122,
            apiData.compraVerde,
            apiData.compraConjunta,
            apiData.acceptedBidsFormat,
            certString
          ],
          function(err) {
            if (err) reject(err);
            else resolve(this.changes);
          }
        );
      });
    } else {
      const idx = jsonDb.process_api_data.findIndex(a => a.notice_uid === apiData.noticeUID);
      const newApiData = {
        notice_uid: apiData.noticeUID,
        reference: apiData.reference,
        dirigido_mipymes: apiData.dirigidoMipymes,
        dirigido_mipymes_mujeres: apiData.dirigidoMipymesMujeres,
        proceso_lotificado: apiData.procesoLotificado,
        decreto_presidencial: apiData.decretoPresidencial,
        resolucion_maxima_autoridad: apiData.resolucionMaximaAutoridad,
        organismo_financiero_externo: apiData.organismoFinancieroExterno,
        marco_decreto_3122: apiData.marcoDecreto3122,
        compra_verde: apiData.compraVerde,
        compra_conjunta: apiData.compraConjunta,
        accepted_bids_format: apiData.acceptedBidsFormat,
        apropiacion_presupuestaria: certString
      };

      if (idx >= 0) {
        jsonDb.process_api_data[idx] = newApiData;
      } else {
        jsonDb.process_api_data.push(newApiData);
      }
      saveJsonToFile();
      return Promise.resolve(1);
    }
  },

  // Get paginated, filtered list of notices
  getNotices({ search, minPrice, maxPrice, phase, state, mipymes, snip, page = 1, limit = 15 }) {
    const offset = (page - 1) * limit;

    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        let sql = `
          FROM notices n
          LEFT JOIN notice_details d ON n.uid = d.notice_uid
          LEFT JOIN process_api_data a ON n.uid = a.notice_uid
          WHERE 1=1
        `;
        const params = [];

        if (search) {
          sql += ` AND (n.reference LIKE ? OR n.buyer_name LIKE ? OR n.description LIKE ? OR n.uid LIKE ?)`;
          const wildcard = `%${search}%`;
          params.push(wildcard, wildcard, wildcard, wildcard);
        }
        if (minPrice) {
          sql += ` AND n.base_price_num >= ?`;
          params.push(parseFloat(minPrice));
        }
        if (maxPrice) {
          sql += ` AND n.base_price_num <= ?`;
          params.push(parseFloat(maxPrice));
        }
        if (phase) {
          sql += ` AND n.phase = ?`;
          params.push(phase);
        }
        if (state) {
          sql += ` AND n.state = ?`;
          params.push(state);
        }
        if (mipymes === 'true') {
          sql += ` AND (a.dirigido_mipymes = 'Sí' OR a.dirigido_mipymes = 'Yes' OR a.dirigido_mipymes_mujeres = 'Sí' OR a.dirigido_mipymes_mujeres = 'Yes')`;
        }
        if (snip === 'true') {
          sql += ` AND d.snip = 'Snip'`;
        }

        const countSql = `SELECT COUNT(DISTINCT n.uid) as total ` + sql;
        const selectSql = `
          SELECT DISTINCT 
            n.uid, n.country, n.buyer_name, n.reference, n.description, 
            n.phase, n.publish_date, n.submission_date, n.base_price, 
            n.base_price_num, n.state, n.scraped_at, n.detail_scraped,
            a.dirigido_mipymes, a.dirigido_mipymes_mujeres, d.snip,
            d.procedure_type, d.type_of_contract,
            (SELECT SUM(aw.award_value_num) FROM notice_awards aw WHERE aw.notice_uid = n.uid) as total_awarded
          ` + sql + ` ORDER BY n.scraped_at DESC LIMIT ? OFFSET ?`;

        sqliteDb.get(countSql, params, (err, countRow) => {
          if (err) return reject(err);
          const total = countRow ? countRow.total : 0;

          sqliteDb.all(selectSql, [...params, parseInt(limit), parseInt(offset)], (err, rows) => {
            if (err) reject(err);
            else resolve({ total, page, limit, data: rows });
          });
        });
      });
    } else {
      // JSON querying fallback
      let filtered = [...jsonDb.notices];

      // Join details and api data
      const joined = filtered.map(n => {
        const details = jsonDb.notice_details.find(d => d.notice_uid === n.uid) || {};
        const api = jsonDb.process_api_data.find(a => a.notice_uid === n.uid) || {};
        const noticeAwards = jsonDb.notice_awards.filter(aw => aw.notice_uid === n.uid);
        const total_awarded = noticeAwards.reduce((sum, aw) => sum + (aw.award_value_num || 0), 0);
        return {
          ...n,
          dirigido_mipymes: api.dirigido_mipymes,
          dirigido_mipymes_mujeres: api.dirigido_mipymes_mujeres,
          snip: details.snip,
          procedure_type: details.procedure_type,
          type_of_contract: details.type_of_contract,
          total_awarded: total_awarded > 0 ? total_awarded : null
        };
      });

      let result = joined;

      if (search) {
        const term = search.toLowerCase();
        result = result.filter(n => 
          (n.reference && n.reference.toLowerCase().includes(term)) ||
          (n.buyer_name && n.buyer_name.toLowerCase().includes(term)) ||
          (n.description && n.description.toLowerCase().includes(term)) ||
          (n.uid && n.uid.toLowerCase().includes(term))
        );
      }
      if (minPrice) {
        result = result.filter(n => n.base_price_num >= parseFloat(minPrice));
      }
      if (maxPrice) {
        result = result.filter(n => n.base_price_num <= parseFloat(maxPrice));
      }
      if (phase) {
        result = result.filter(n => n.phase === phase);
      }
      if (state) {
        result = result.filter(n => n.state === state);
      }
      if (mipymes === 'true') {
        result = result.filter(n => 
          n.dirigido_mipymes === 'Sí' || n.dirigido_mipymes === 'Yes' ||
          n.dirigido_mipymes_mujeres === 'Sí' || n.dirigido_mipymes_mujeres === 'Yes'
        );
      }
      if (snip === 'true') {
        result = result.filter(n => n.snip === 'Snip');
      }

      // Sort by scraped_at DESC
      result.sort((a, b) => new Date(b.scraped_at) - new Date(a.scraped_at));

      const total = result.length;
      const paginated = result.slice(offset, offset + limit);

      return Promise.resolve({
        total,
        page,
        limit,
        data: paginated
      });
    }
  },

  getNoticeBasic(uidOrRef) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.get(
          `SELECT n.*, (SELECT COUNT(*) FROM notice_awards a WHERE a.notice_uid = n.uid) as award_count 
           FROM notices n 
           WHERE n.uid = ? OR n.reference = ? OR n.reference LIKE ? 
           LIMIT 1`,
          [uidOrRef, uidOrRef, `%${uidOrRef}%`],
          (err, row) => {
            if (err) reject(err);
            else resolve(row ? { 
              uid: row.uid, 
              reference: row.reference, 
              state: row.state, 
              phase: row.phase, 
              detail_scraped: row.detail_scraped,
              publish_date: row.publish_date,
              submission_date: row.submission_date,
              award_count: row.award_count
            } : null);
          }
        );
      });
    } else {
      const notice = jsonDb.notices.find(n => n.uid === uidOrRef || n.reference === uidOrRef || (n.reference && n.reference.includes(uidOrRef)));
      if (!notice) return Promise.resolve(null);
      const awards = jsonDb.notice_awards.filter(a => a.notice_uid === notice.uid);
      return Promise.resolve({ 
        uid: notice.uid, 
        reference: notice.reference, 
        state: notice.state, 
        phase: notice.phase, 
        detail_scraped: notice.detail_scraped,
        publish_date: notice.publish_date,
        submission_date: notice.submission_date,
        award_count: awards.length
      });
    }
  },

  // Get full details of a notice by either UID or Reference
  getNoticeDetailByRefOrUid(refOrUid) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        const findSql = `SELECT uid FROM notices WHERE uid = ? OR reference = ? OR reference LIKE ? LIMIT 1`;
        sqliteDb.get(findSql, [refOrUid, refOrUid, `%${refOrUid}%`], (err, row) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          this.getNoticeDetail(row.uid).then(resolve).catch(reject);
        });
      });
    } else {
      const notice = jsonDb.notices.find(n => n.uid === refOrUid || n.reference === refOrUid || (n.reference && n.reference.includes(refOrUid)));
      if (!notice) return Promise.resolve(null);
      return this.getNoticeDetail(notice.uid);
    }
  },

  // Get full details of a notice
  getNoticeDetail(noticeUID) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        const noticeSql = `SELECT * FROM notices WHERE uid = ?`;
        const detailSql = `SELECT * FROM notice_details WHERE notice_uid = ?`;
        const schedSql = `SELECT * FROM notice_schedules WHERE notice_uid = ?`;
        const apiSql = `SELECT * FROM process_api_data WHERE notice_uid = ?`;
        const docSql = `SELECT * FROM notice_documents WHERE notice_uid = ?`;
        const itemSql = `SELECT * FROM notice_items WHERE notice_uid = ?`;

        sqliteDb.get(noticeSql, [noticeUID], (err, notice) => {
          if (err) return reject(err);
          if (!notice) return resolve(null);

          sqliteDb.get(detailSql, [noticeUID], (err, details) => {
            if (err) return reject(err);

            sqliteDb.all(schedSql, [noticeUID], (err, schedules) => {
              if (err) return reject(err);

              sqliteDb.get(apiSql, [noticeUID], (err, apiData) => {
                if (err) return reject(err);

                if (apiData && apiData.apropiacion_presupuestaria) {
                  try {
                    apiData.apropiacion_presupuestaria = JSON.parse(apiData.apropiacion_presupuestaria);
                  } catch (e) {
                    apiData.apropiacion_presupuestaria = [];
                  }
                }

                sqliteDb.all(docSql, [noticeUID], (err, documents) => {
                  if (err) return reject(err);

                  sqliteDb.all(itemSql, [noticeUID], (err, items) => {
                    if (err) return reject(err);

                    // Fetch awards for this notice
                    sqliteDb.all(`SELECT * FROM notice_awards WHERE notice_uid = ?`, [noticeUID], (err, awards) => {
                      if (err) return reject(err);

                      if (!awards || awards.length === 0) {
                        return resolve({
                          notice,
                          details: details || null,
                          schedules: schedules || [],
                          apiData: apiData || null,
                          documents: documents || [],
                          items: items || [],
                          awards: []
                        });
                      }

                      const awardIds = awards.map(a => a.award_id);
                      const placeholders = awardIds.map(() => '?').join(',');

                      sqliteDb.all(`SELECT * FROM notice_award_reports WHERE award_id IN (${placeholders})`, awardIds, (err, reports) => {
                        if (err) return reject(err);

                        sqliteDb.all(`SELECT * FROM notice_awardees WHERE award_id IN (${placeholders})`, awardIds, (err, awardees) => {
                          if (err) return reject(err);

                          // Group reports and awardees by award_id
                          const reportsByAward = {};
                          const awardeesByAward = {};

                          (reports || []).forEach(r => {
                            if (!reportsByAward[r.award_id]) reportsByAward[r.award_id] = [];
                            reportsByAward[r.award_id].push(r);
                          });

                          (awardees || []).forEach(e => {
                            if (!awardeesByAward[e.award_id]) awardeesByAward[e.award_id] = [];
                            awardeesByAward[e.award_id].push(e);
                          });

                          const fullAwards = awards.map(a => ({
                            award_id: a.award_id,
                            award_date: a.award_date,
                            award_value: a.award_value,
                            award_value_num: a.award_value_num,
                            reports: reportsByAward[a.award_id] || [],
                            awardees: awardeesByAward[a.award_id] || []
                          }));

                          resolve({
                            notice,
                            details: details || null,
                            schedules: schedules || [],
                            apiData: apiData || null,
                            documents: documents || [],
                            items: items || [],
                            awards: fullAwards
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    } else {
      const notice = jsonDb.notices.find(n => n.uid === noticeUID);
      if (!notice) return Promise.resolve(null);

      const details = jsonDb.notice_details.find(d => d.notice_uid === noticeUID) || null;
      const schedules = jsonDb.notice_schedules.filter(s => s.notice_uid === noticeUID) || [];
      const apiDataRaw = jsonDb.process_api_data.find(a => a.notice_uid === noticeUID) || null;
      const documents = jsonDb.notice_documents.filter(d => d.notice_uid === noticeUID) || [];
      const items = jsonDb.notice_items.filter(i => i.notice_uid === noticeUID) || [];

      let apiData = null;
      if (apiDataRaw) {
        apiData = { ...apiDataRaw };
        if (apiData.apropiacion_presupuestaria) {
          try {
            apiData.apropiacion_presupuestaria = JSON.parse(apiData.apropiacion_presupuestaria);
          } catch (e) {
            apiData.apropiacion_presupuestaria = [];
          }
        }
      }

      // Fetch awards for JSON fallback
      const awards = jsonDb.notice_awards.filter(a => a.notice_uid === noticeUID) || [];
      const fullAwards = awards.map(a => {
        const reports = jsonDb.notice_award_reports.filter(r => r.award_id === a.award_id) || [];
        const awardees = jsonDb.notice_awardees.filter(e => e.award_id === a.award_id) || [];
        return {
          award_id: a.award_id,
          award_date: a.award_date,
          award_value: a.award_value,
          award_value_num: a.award_value_num,
          reports,
          awardees
        };
      });

      return Promise.resolve({
        notice,
        details,
        schedules,
        apiData,
        documents,
        items,
        awards: fullAwards
      });
    }
  },

  // Get statistics for dashboard cards
  getStats() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        const sql = `
          SELECT 
            COUNT(DISTINCT n.uid) as totalNotices,
            SUM(n.base_price_num) as totalBudget,
            SUM(CASE WHEN a.dirigido_mipymes = 'Sí' OR a.dirigido_mipymes = 'Yes' OR a.dirigido_mipymes_mujeres = 'Sí' OR a.dirigido_mipymes_mujeres = 'Yes' THEN 1 ELSE 0 END) as mipymesCount,
            SUM(CASE WHEN d.snip = 'Snip' THEN 1 ELSE 0 END) as snipCount
          FROM notices n
          LEFT JOIN notice_details d ON n.uid = d.notice_uid
          LEFT JOIN process_api_data a ON n.uid = a.notice_uid
        `;

        sqliteDb.get(sql, [], (err, row) => {
          if (err) reject(err);
          else resolve(row || { totalNotices: 0, totalBudget: 0, mipymesCount: 0, snipCount: 0 });
        });
      });
    } else {
      let totalNotices = jsonDb.notices.length;
      let totalBudget = jsonDb.notices.reduce((acc, curr) => acc + (curr.base_price_num || 0), 0);
      let mipymesCount = jsonDb.process_api_data.filter(a => 
        a.dirigido_mipymes === 'Sí' || a.dirigido_mipymes === 'Yes' ||
        a.dirigido_mipymes_mujeres === 'Sí' || a.dirigido_mipymes_mujeres === 'Yes'
      ).length;
      let snipCount = jsonDb.notice_details.filter(d => d.snip === 'Snip').length;

      return Promise.resolve({
        totalNotices,
        totalBudget,
        mipymesCount,
        snipCount
      });
    }
  },

  // Logging mechanism for scraping operations
  startScrapeLog(pagesRequested) {
    const started_at = new Date().toISOString();
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.run(
          `INSERT INTO scrapes (started_at, status, pages_requested, logs) VALUES (?, ?, ?, ?)`,
          [started_at, 'running', pagesRequested, ''],
          function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });
    } else {
      const id = jsonDb.scrapes.length + 1;
      jsonDb.scrapes.push({
        id,
        started_at,
        ended_at: null,
        status: 'running',
        pages_requested: pagesRequested,
        notices_found: 0,
        notices_processed: 0,
        logs: ''
      });
      saveJsonToFile();
      return Promise.resolve(id);
    }
  },

  updateScrapeLog(runId, status, noticesFound, noticesProcessed) {
    const ended_at = status !== 'running' ? new Date().toISOString() : null;

    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        let sql = `UPDATE scrapes SET status = ?, notices_found = ?, notices_processed = ?`;
        const params = [status, noticesFound, noticesProcessed];
        if (ended_at) {
          sql += `, ended_at = ?`;
          params.push(ended_at);
        }
        sql += ` WHERE id = ?`;
        params.push(runId);

        sqliteDb.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        });
      });
    } else {
      const run = jsonDb.scrapes.find(s => s.id === runId);
      if (run) {
        run.status = status;
        run.notices_found = noticesFound;
        run.notices_processed = noticesProcessed;
        if (ended_at) {
          run.ended_at = ended_at;
        }
        saveJsonToFile();
      }
      return Promise.resolve(1);
    }
  },

  addScrapeLogMsg(runId, message) {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMsg = `[${timestamp}] ${message}\n`;

    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.run(
          `UPDATE scrapes SET logs = COALESCE(logs, '') || ? WHERE id = ?`,
          [formattedMsg, runId],
          function(err) {
            if (err) reject(err);
            else resolve(this.changes);
          }
        );
      });
    } else {
      const run = jsonDb.scrapes.find(s => s.id === runId);
      if (run) {
        run.logs = (run.logs || '') + formattedMsg;
        saveJsonToFile();
      }
      return Promise.resolve(1);
    }
  },

  getLatestScrapeLog() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.get(
          `SELECT * FROM scrapes ORDER BY id DESC LIMIT 1`,
          [],
          (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
          }
        );
      });
    } else {
      if (jsonDb.scrapes.length === 0) return Promise.resolve(null);
      return Promise.resolve(jsonDb.scrapes[jsonDb.scrapes.length - 1]);
    }
  },

  saveSuppliers(suppliersList) {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          sqliteDb.run("BEGIN TRANSACTION", (beginErr) => {
            if (beginErr) return reject(beginErr);

            const stmt = sqliteDb.prepare(`
              INSERT OR REPLACE INTO suppliers (
                rpe, razon_social, numero_documento, tipo_documento, estado_rpe, genero, tipo_persona, forma_juridica,
                mipyme, certificado_micm, clasificacion, clasificacion_empresarial, provincia, municipio,
                correo, telefono, direccion, contacto, observacion
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            suppliersList.forEach(s => {
              stmt.run([
                s.rpe, s.razon_social, s.numero_documento, s.tipo_documento, s.estado_rpe, s.genero, s.tipo_persona, s.forma_juridica,
                s.mipyme, s.certificado_micm, s.clasificacion, s.clasificacion_empresarial, s.provincia, s.municipio,
                s.correo, s.telefono, s.direccion, s.contacto, s.observacion
              ]);
            });

            stmt.finalize((err) => {
              if (err) {
                sqliteDb.run("ROLLBACK");
                reject(err);
              } else {
                sqliteDb.run("COMMIT", (commitErr) => {
                  if (commitErr) {
                    sqliteDb.run("ROLLBACK");
                    reject(commitErr);
                  } else {
                    resolve(suppliersList.length);
                  }
                });
              }
            });
          });
        });
      });
    } else {
      suppliersList.forEach(s => {
        const idx = jsonDb.suppliers.findIndex(existing => existing.rpe === s.rpe);
        if (idx >= 0) {
          jsonDb.suppliers[idx] = s;
        } else {
          jsonDb.suppliers.push(s);
        }
      });
      saveJsonToFile();
      return Promise.resolve(suppliersList.length);
    }
  },

  getSuppliers() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.all(`SELECT * FROM suppliers`, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    } else {
      return Promise.resolve(jsonDb.suppliers || []);
    }
  },

  getSuppliersPaginated({ search = '', mipyme = '', genero = '', page = 1, limit = 25 }) {
    const offset = (page - 1) * limit;
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        let countSql = `SELECT COUNT(*) as total FROM suppliers WHERE 1=1`;
        let selectSql = `SELECT * FROM suppliers WHERE 1=1`;
        const params = [];

        if (search) {
          const wildcard = `%${search}%`;
          const filter = ` AND (rpe LIKE ? OR razon_social LIKE ? OR numero_documento LIKE ?)`;
          countSql += filter;
          selectSql += filter;
          params.push(wildcard, wildcard, wildcard);
        }
        if (mipyme && mipyme !== 'todos') {
          if (mipyme === 'si') {
            const filter = ` AND LOWER(mipyme) IN ('si', 'sí')`;
            countSql += filter;
            selectSql += filter;
          } else {
            const filter = ` AND (LOWER(mipyme) NOT IN ('si', 'sí') OR mipyme IS NULL)`;
            countSql += filter;
            selectSql += filter;
          }
        }
        if (genero && genero !== 'todos') {
          const filter = ` AND LOWER(genero) = LOWER(?)`;
          countSql += filter;
          selectSql += filter;
          params.push(genero);
        }

        selectSql += ` LIMIT ? OFFSET ?`;

        sqliteDb.get(countSql, params, (err, countRow) => {
          if (err) return reject(err);
          const total = countRow ? countRow.total : 0;

          sqliteDb.all(selectSql, [...params, parseInt(limit), parseInt(offset)], (err, rows) => {
            if (err) reject(err);
            else resolve({ total, rows });
          });
        });
      });
    } else {
      let filtered = [...(jsonDb.suppliers || [])];
      if (search) {
        const term = search.toLowerCase();
        filtered = filtered.filter(s => 
          (s.rpe && s.rpe.toLowerCase().includes(term)) ||
          (s.razon_social && s.razon_social.toLowerCase().includes(term)) ||
          (s.numero_documento && s.numero_documento.toLowerCase().includes(term))
        );
      }
      if (mipyme && mipyme !== 'todos') {
        const target = mipyme === 'si' ? 'si' : 'no';
        filtered = filtered.filter(s => (s.mipyme || '').toLowerCase() === target || (s.mipyme || '').toLowerCase() === (target === 'si' ? 'sí' : 'no'));
      }
      if (genero && genero !== 'todos') {
        filtered = filtered.filter(s => (s.genero || '').toLowerCase() === genero.toLowerCase());
      }
      const total = filtered.length;
      const paginated = filtered.slice(offset, offset + limit);
      return Promise.resolve({ total, rows: paginated });
    }
  },

  getSupplierStats() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        const sql = `
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN LOWER(mipyme) IN ('si', 'sí') THEN 1 ELSE 0 END) as mipymeCount,
            SUM(CASE WHEN LOWER(genero) = 'femenino' THEN 1 ELSE 0 END) as femaleCount
          FROM suppliers
        `;
        sqliteDb.get(sql, [], (err, row) => {
          if (err) reject(err);
          else resolve(row || { total: 0, mipymeCount: 0, femaleCount: 0 });
        });
      });
    } else {
      const total = (jsonDb.suppliers || []).length;
      const mipymeCount = (jsonDb.suppliers || []).filter(s => (s.mipyme || '').toLowerCase() === 'si' || (s.mipyme || '').toLowerCase() === 'sí').length;
      const femaleCount = (jsonDb.suppliers || []).filter(s => (s.genero || '').toLowerCase() === 'femenino').length;
      return Promise.resolve({ total, mipymeCount, femaleCount });
    }
  },

  getNoticeAwardees() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.all(`
          SELECT 
            a.name as awardee_name, 
            a.value as award_value, 
            a.value_num as award_value_num,
            n.uid as notice_uid, 
            n.reference as notice_reference, 
            n.description as notice_description, 
            n.publish_date as notice_publish_date,
            n.state as notice_state,
            aw.award_date as award_date
          FROM notice_awardees a
          JOIN notice_awards aw ON a.award_id = aw.award_id
          JOIN notices n ON aw.notice_uid = n.uid
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    } else {
      const result = (jsonDb.notice_awardees || []).map(a => {
        const aw = jsonDb.notice_awards.find(w => w.award_id === a.award_id) || {};
        const n = jsonDb.notices.find(nt => nt.uid === aw.notice_uid) || {};
        return {
          awardee_name: a.name,
          award_value: a.value,
          award_value_num: a.value_num,
          notice_uid: n.uid,
          notice_reference: n.reference,
          notice_description: n.description,
          notice_publish_date: n.publish_date,
          notice_state: n.state,
          award_date: aw.award_date
        };
      });
      return Promise.resolve(result);
    }
  },

  saveImportedProcess(proc) {
    const uid = 'IMP.' + proc.reference.replace(/[^a-zA-Z0-9]/g, '.');
    const award_id = 'IMP.AWD.' + proc.reference.replace(/[^a-zA-Z0-9]/g, '.');
    const scraped_at = new Date().toISOString();
    const base_price = proc.amount ? `${proc.amount.toLocaleString()} Pesos Dominicanos` : '0 Pesos Dominicanos';
    const base_price_num = proc.amount || 0;
    
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
          sqliteDb.run(`
            INSERT OR REPLACE INTO notices (
              uid, country, buyer_name, reference, description, phase, 
              publish_date, submission_date, base_price, base_price_num, 
              state, scraped_at, detail_scraped
            ) VALUES (?, 'DO', ?, ?, ?, 'Importado', ?, ?, ?, ?, 'Awarded', ?, 1)
          `, [uid, proc.buyer_name, proc.reference, proc.description, proc.publish_date, proc.publish_date, base_price, base_price_num, scraped_at], (err) => {
            if (err) return reject(err);
          });
          
          sqliteDb.run(`
            INSERT OR REPLACE INTO notice_awards (
              award_id, notice_uid, award_date, award_value, award_value_num
            ) VALUES (?, ?, ?, ?, ?)
          `, [award_id, uid, proc.publish_date, base_price, base_price_num], (err) => {
            if (err) return reject(err);
          });
          
          sqliteDb.run(`
            INSERT INTO notice_awardees (
              award_id, name, value, value_num
            ) VALUES (?, ?, ?, ?)
          `, [award_id, proc.supplier_name, base_price, base_price_num], (err) => {
            if (err) return reject(err);
          });
          
          resolve(1);
        });
      });
    } else {
      const notice = {
        uid,
        country: 'DO',
        buyer_name: proc.buyer_name,
        reference: proc.reference,
        description: proc.description,
        phase: 'Importado',
        publish_date: proc.publish_date,
        submission_date: proc.publish_date,
        base_price,
        base_price_num,
        state: 'Awarded',
        scraped_at,
        detail_scraped: 1
      };
      const idxNotice = jsonDb.notices.findIndex(n => n.uid === uid);
      if (idxNotice >= 0) jsonDb.notices[idxNotice] = notice;
      else jsonDb.notices.push(notice);

      const award = {
        award_id,
        notice_uid: uid,
        award_date: proc.publish_date,
        award_value: base_price,
        award_value_num: base_price_num
      };
      const idxAward = jsonDb.notice_awards.findIndex(a => a.award_id === award_id);
      if (idxAward >= 0) jsonDb.notice_awards[idxAward] = award;
      else jsonDb.notice_awards.push(award);

      const awardee = {
        award_id,
        name: proc.supplier_name,
        value: base_price,
        value_num: base_price_num
      };
      jsonDb.notice_awardees.push(awardee);
      
      saveJsonToFile();
      return Promise.resolve(1);
    }
  },

  getCollusionAnalysis() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        const q = `
          SELECT 
            s1.razon_social as company_a,
            s2.razon_social as company_b,
            s1.rpe as rpe_a,
            s2.rpe as rpe_b,
            s1.telefono,
            s1.correo,
            s1.direccion
          FROM suppliers s1
          JOIN suppliers s2 ON s1.rpe < s2.rpe
          WHERE (
            (s1.telefono IS NOT NULL AND s1.telefono != '' AND s1.telefono = s2.telefono AND s1.telefono NOT IN ('0', 'N/A', '0000000000', '—', '-')) OR
            (s1.correo IS NOT NULL AND s1.correo != '' AND LOWER(s1.correo) = LOWER(s2.correo) AND s1.correo NOT IN ('n/a', 'no@correo.com', '—'))
          )
          LIMIT 100
        `;
        sqliteDb.all(q, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    } else {
      const results = [];
      const sups = jsonDb.suppliers || [];
      for (let i = 0; i < sups.length; i++) {
        for (let j = i + 1; j < sups.length; j++) {
          const s1 = sups[i];
          const s2 = sups[j];
          const telMatch = s1.telefono && s1.telefono !== '' && s1.telefono === s2.telefono && !['0', 'N/A', '0000000000', '—', '-'].includes(s1.telefono);
          const mailMatch = s1.correo && s1.correo !== '' && s1.correo.toLowerCase() === s2.correo.toLowerCase() && !['n/a', 'no@correo.com', '—'].includes(s1.correo.toLowerCase());
          if (telMatch || mailMatch) {
            results.push({
              company_a: s1.razon_social,
              company_b: s2.razon_social,
              rpe_a: s1.rpe,
              rpe_b: s2.rpe,
              telefono: s1.telefono,
              correo: s1.correo,
              direccion: s1.direccion
            });
            if (results.length >= 100) break;
          }
        }
        if (results.length >= 100) break;
      }
      return Promise.resolve(results);
    }
  },

  getSplittingAnalysis() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        const q = `
          SELECT 
            n.buyer_name,
            ni.category,
            COUNT(DISTINCT n.uid) as process_count,
            SUM(n.base_price_num) as total_amount,
            GROUP_CONCAT(DISTINCT n.uid) as notices_list
          FROM notices n
          JOIN notice_items ni ON n.uid = ni.notice_uid
          JOIN notice_details nd ON n.uid = nd.notice_uid
          WHERE (nd.procedure_type LIKE '%Debajo%' OR nd.procedure_type LIKE '%Menor%') AND n.buyer_name != ''
          GROUP BY n.buyer_name, ni.category
          HAVING process_count > 1
          ORDER BY total_amount DESC
          LIMIT 100
        `;
        sqliteDb.all(q, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    } else {
      return Promise.resolve([]);
    }
  },

  getDirectedBiddingAnalysis() {
    if (dbEngine === 'sqlite') {
      return new Promise((resolve, reject) => {
        sqliteDb.all(`
          SELECT n.uid, n.reference, n.buyer_name, n.description, n.publish_date, n.submission_date, n.base_price_num,
                 d.procedure_type
          FROM notices n
          LEFT JOIN notice_details d ON d.notice_uid = n.uid
          WHERE n.publish_date IS NOT NULL AND n.submission_date IS NOT NULL
            AND (d.procedure_type IS NULL OR (
              d.procedure_type != 'Compras por Debajo del Umbral'
              AND d.procedure_type != 'Contratación Menor'
            ))
        `, [], (err, rows) => {
          if (err) return reject(err);
          const results = [];
          
          const parseDBDate = (dateStr) => {
            if (!dateStr) return null;
            const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
            if (match) {
              return new Date(
                parseInt(match[3]),
                parseInt(match[2]) - 1,
                parseInt(match[1]),
                parseInt(match[4]),
                parseInt(match[5])
              );
            }
            return new Date(dateStr.split(' (UTC')[0]);
          };

          rows.forEach(r => {
            const pub = parseDBDate(r.publish_date);
            const sub = parseDBDate(r.submission_date);
            if (pub && sub && !isNaN(pub.getTime()) && !isNaN(sub.getTime())) {
              const diffHrs = (sub.getTime() - pub.getTime()) / (1000 * 60 * 60);
              if (diffHrs > 0 && diffHrs <= 72) {
                results.push({
                  uid: r.uid,
                  reference: r.reference,
                  buyer_name: r.buyer_name,
                  description: r.description,
                  publish_date: r.publish_date,
                  submission_date: r.submission_date,
                  hours_to_submit: Math.round(diffHrs * 10) / 10,
                  base_price_num: r.base_price_num
                });
              }
            }
          });

          results.sort((a, b) => a.hours_to_submit - b.hours_to_submit);
          resolve(results.slice(0, 100));
        });
      });
    } else {
      return Promise.resolve([]);
    }
  }
};

module.exports = db;

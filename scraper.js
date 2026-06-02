const https = require('https');
const querystring = require('querystring');
const cheerio = require('cheerio');
const db = require('./db');

// Global running status
let isScraping = false;
let currentRunId = null;

// Native HTTPS GET helper with timeout
function fetchGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    };

    const requestOptions = {
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) },
      rejectUnauthorized: false // bypass SSL verification issues on port 9943
    };

    const req = https.get(url, requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });

    req.on('error', (err) => reject(err));
    
    // Set a 15-second timeout
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout (' + url + ')'));
    });
  });
}

// Native HTTPS POST helper
function fetchPost(url, postData, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof postData === 'string' ? postData : querystring.stringify(postData);
    
    const defaultHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Length': Buffer.byteLength(payload)
    };

    const requestOptions = {
      method: 'POST',
      ...options,
      headers: { ...defaultHeaders, ...(options.headers || {}) },
      rejectUnauthorized: false
    };

    const req = https.request(url, requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('POST Request timeout (' + url + ')'));
    });

    req.write(payload);
    req.end();
  });
}

// Helper to clean HTML text
function cleanText(text) {
  return text ? text.replace(/\s+/g, ' ').trim() : '';
}

// Helper to normalize date formats to DD/MM/YYYY HH:mm (UTC -4 horas)
function normalizeDateStr(dateStr) {
  if (!dateStr) return '';
  const dateRegex = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})(?::\d{2})?/;
  const match = dateStr.match(dateRegex);
  if (match) {
    return `${match[1]} ${match[2]} (UTC -4 horas)`;
  }
  return dateStr;
}

// Extract noticeUID from the onclick support modal script
function extractNoticeUID(onclickStr) {
  if (!onclickStr) return '';
  const match = onclickStr.match(/(DO1\.NTC\.\d+)/i);
  return match ? match[1] : '';
}

// Parse rows of notices from HTML table using Cheerio
function parseNoticeRows(html) {
  const $ = cheerio.load(html);
  const notices = [];
  
  // Find rows in the table
  $('tr[id*="grdResultList_tr"]').each((_, elem) => {
    const tr = $(elem);
    
    const country = cleanText(tr.find('td[id*="thCountryColumn"]').text());
    const buyerName = cleanText(tr.find('td[id*="thAuthorityNameCol"]').text());
    const reference = cleanText(tr.find('td[id*="thUniqueIdentifierCol"]').text());
    const description = cleanText(tr.find('td[id*="thDescriptionCol"]').text());
    const phase = cleanText(tr.find('td[id*="thCurrentPhaseCol"]').text());
    
    // Dates are formatted inside a date box span
    const publishDate = normalizeDateStr(cleanText(tr.find('td[id*="thOfficialPublishDateCol"]').text()));
    const submissionDate = normalizeDateStr(cleanText(tr.find('td[id*="thDeadlineCol"]').text()));
    
    const basePrice = cleanText(tr.find('td[id*="thBasePriceColElements"]').text());
    const state = cleanText(tr.find('td[id*="thContractNoticeStateCol"]').text());
    
    // Extract NoticeUID from Detail button onclick
    const onclickStr = tr.find('td[id*="thDetailColumn"] a').attr('onclick');
    const uid = extractNoticeUID(onclickStr);
    
    if (uid && reference) {
      notices.push({
        uid,
        country,
        buyerName,
        reference,
        description,
        phase,
        publishDate,
        submissionDate,
        basePrice,
        state
      });
    }
  });
  
  return notices;
}

// Scrape Details for a single Notice
async function scrapeSingleNoticeDetails(runId, notice, tokenFromConfig) {
  let reference = notice.reference || '';
  const log = (msg) => {
    console.log(`[Notice ${reference || notice.uid}] ${msg}`);
    if (runId) {
      db.addScrapeLogMsg(runId, `[${reference || notice.uid}] ${msg}`);
    }
  };

  try {
    const detailUrl = `https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/Index?noticeUID=${notice.uid}`;
    log('Fetching detail HTML page...');
    
    const response = await fetchGet(detailUrl);
    if (response.statusCode !== 200) {
      log(`Error fetching detail page. HTTP ${response.statusCode}`);
      return false;
    }

    const $ = cheerio.load(response.data);

    // Parse basic notice details from the page to allow self-contained insertion/updating
    reference = cleanText($('#fdsRequestSummaryInfo_tblDetail_trRowRef_tdCell2_spnRequestReference').text()) || reference;
    const buyerName = cleanText($('.CompanyFullName').first().text()) || notice.buyerName || '';
    const description = cleanText($('#fdsRequestSummaryInfo_tblDetail_trRowName_tdCell2_spnRequestName').text()) || 
                        cleanText($('#fdsRequestSummaryInfo_tblDetail_trRowDescription_tdCell2_spnDescription').text()) || 
                        notice.description || '';
    const phase = cleanText($('#fdsRequestSummaryInfo_tblDetail_trRowPhase_tdCell2_spnPhase').text()) || notice.phase || '';
    const state = cleanText($('#fdsRequestSummaryInfo_tblDetail_trRowState_tdCell2_spnState').text()) || notice.state || '';
    const basePrice = cleanText($('#cbxBasePriceValue').text()) || notice.basePrice || '';
    
    // Parse Timeline / Scheduling milestones first
    const schedules = [];
    $('#fdsSchedulingP2Gen_tblDetail tr[id*="trScheduleDateRow_"]').each((_, elem) => {
      const tr = $(elem);
      const label = cleanText(tr.find('td.Label label').text());
      const dateText = cleanText(tr.find('td.Field .VortalDateBox span').text());
      
      if (label && dateText) {
        schedules.push({
          label,
          dateStr: normalizeDateStr(dateText)
        });
      }
    });

    let publishDate = normalizeDateStr(notice.publishDate || notice.publish_date || '');
    let submissionDate = normalizeDateStr(notice.submissionDate || notice.submission_date || '');

    // If dates are missing (e.g. direct URL sync without list page), resolve them from schedules milestones
    if (!publishDate || !submissionDate) {
      schedules.forEach(s => {
        const labelLower = s.label.toLowerCase();
        if (!publishDate && (labelLower.includes('publicación del aviso') || labelLower.includes('publicación del proceso') || labelLower.includes('fecha de publicación'))) {
          publishDate = s.dateStr;
        }
        if (!submissionDate && (labelLower.includes('recepción de oferta') || labelLower.includes('presentación de oferta') || labelLower.includes('límite para presentar') || labelLower.includes('límite para recepción'))) {
          submissionDate = s.dateStr;
        }
      });
    }

    // Save/update basic notice info in db first (satisfies FK constraints)
    await db.saveNotice({
      uid: notice.uid,
      country: notice.country || 'DO',
      buyerName,
      reference,
      description,
      phase,
      publishDate,
      submissionDate,
      basePrice,
      state
    });

    // 1. Parse Contract Object details
    const procedureType = cleanText($('#fdsRequestSummaryInfo_tblDetail_trRowProcedureType_tdCell2_spnProcedureType').text());
    const typeOfContract = cleanText($('#fdsObjectOfTheContract_tblDetail_trRowTypeOfContract_tdCell2_spnTypeOfContract').text());
    const subtypeOfContract = cleanText($('#fdsObjectOfTheContract_tblDetail_trRowSubTypeOfContract_tdCell2_spnSubTypeOfContract').text());
    const placeOfWork = cleanText($('#fdsObjectOfTheContract_tblDetail_trRowPlaceOfWorks_tdCell2_spnspnPlaceOfWorks').text());
    
    // Total budget values
    const budgetText = cleanText($('#incSigefInfoViewIncludecbxTotalPriceListValueValue').text());
    const budgetCurrency = cleanText($('#incSigefInfoViewIncludetxtTotalPriceListValueCurrency').text()) || 'DOP';
    
    let budgetTotalValue = 0;
    if (budgetText) {
      const match = budgetText.replace(/,/g, '').match(/([\d\.]+)/);
      if (match) {
        budgetTotalValue = parseFloat(match[1]);
      }
    }

    // SNIP fields
    const snipChecked = $('#incSigefInfoViewIncluderdbgIsSnip_0').attr('checked') === 'checked';
    const snip = snipChecked ? 'Snip' : 'No';
    const snipCode = cleanText($('#incSigefInfoViewIncludespnSnipCodeValue').text());

    // Save details to DB
    const detailData = {
      noticeUID: notice.uid,
      procedureType,
      typeOfContract,
      subtypeOfContract,
      placeOfWork,
      budgetTotalValue,
      budgetCurrency,
      expenditureObjective: cleanText($('#incSigefInfoViewIncludespnExpenditureObjectiveValue').text()),
      sourceOfFunds: cleanText($('#incSigefInfoViewIncludespnSourceOfFundsValue').text()),
      manualIntegration: $('#incSigefInfoViewIncludechkManualIntegrationValue').is(':checked') ? 'Yes' : 'No',
      snip,
      snipCode
    };
    await db.saveNoticeDetails(detailData);

    // Save schedules to DB
    await db.saveNoticeSchedules(notice.uid, schedules);
    log(`Parsed ${schedules.length} scheduling milestones.`);

    // 2b. Parse Contract Documents
    const documents = [];
    $('tr[id*="grdGridDocumentList_tr"]').each((_, elem) => {
      const tr = $(elem);
      const name = cleanText(tr.find('td[id*="thColumnDocumentName"] span').text()) || cleanText(tr.find('td[id*="thColumnDocumentName"]').text());
      const type = cleanText(tr.find('td[id*="thColumnDocumentType"] span').text()) || cleanText(tr.find('td[id*="thColumnDocumentType"]').text());
      const downloadOnclick = tr.find('td[id*="thColumnDownloadDocument"] a').attr('onclick') || '';
      
      const fileIdMatch = downloadOnclick.match(/documentFileId.*?(\d+)/i);
      const fileId = fileIdMatch ? fileIdMatch[1] : '';
      const mkeyMatch = downloadOnclick.match(/mkey=([^'&"]+)/i);
      const mkey = mkeyMatch ? mkeyMatch[1] : '';
      
      if (name && fileId && mkey) {
        const downloadUrl = `https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/DownloadFile?documentFileId=${fileId}&mkey=${mkey}`;
        documents.push({
          name,
          type,
          downloadUrl
        });
      }
    });
    await db.saveNoticeDocuments(notice.uid, documents);
    log(`Parsed ${documents.length} contract documents.`);

    // 2c. Parse Questionnaire items (lista de artículos)
    const items = [];
    $('tr.PriceListLineRow[id*="BILItm-"]').each((_, elem) => {
      const tr = $(elem);
      const cells = tr.find('td');
      
      if (cells.length >= 8) {
        const index = cleanText($(cells[0]).text());
        const category = cleanText($(cells[1]).text());
        const account = cleanText($(cells[3]).text());
        const description = cleanText($(cells[4]).text());
        
        const quantityText = cleanText($(cells[5]).text()).replace(/,/g, '');
        const quantity = parseFloat(quantityText) || 0;
        
        const unit = cleanText($(cells[6]).text());
        
        const unitPriceText = cleanText($(cells[7]).text()).replace(/,/g, '');
        const unitPrice = parseFloat(unitPriceText) || 0;
        
        const totalPriceText = cleanText($(cells[8]).text()).replace(/,/g, '');
        const totalPrice = parseFloat(totalPriceText) || 0;

        if (index && description) {
          items.push({
            index,
            category,
            account,
            description,
            quantity,
            unit,
            unitPrice,
            totalPrice
          });
        }
      }
    });
    await db.saveNoticeItems(notice.uid, items);
    log(`Parsed ${items.length} questionnaire items.`);

    // 2d. Parse Selection / Award Info (Información de la selección)
    const awards = [];
    let currentAward = null;
    const flatTree = $('#fltAwardDetailFT');
    if (flatTree.length > 0) {
      const rows = flatTree.find('tr.FltTr');
      rows.each((_, elem) => {
        const tr = $(elem);
        const id = tr.attr('id') || '';
        const level = tr.attr('level') || '0';
        
        if (level === '0') {
          const idTdText = tr.find('td[id$="_ContentTd"]').text().trim();
          const awardId = idTdText || id.replace(/_/g, '.');
          
          let date = '';
          let value = '';
          
          tr.find('td.FltContentTdAwardDetail').each((_, tdElem) => {
            const td = $(tdElem);
            const span = td.find('.VortalSpan');
            const numSpan = td.find('.VortalNumericSpan');
            if (numSpan.length > 0) {
              value = numSpan.text().trim();
            } else if (span.length > 0) {
              const text = span.text().trim();
              if (text && text !== awardId) {
                date = normalizeDateStr(text);
              }
            }
          });

          currentAward = {
            id: awardId,
            date: date,
            value: value,
            reports: [],
            awardees: []
          };
          awards.push(currentAward);
        } else if (level === '1' && currentAward) {
          const idTdText = tr.find('td[id$="_ContentTd"]').text().trim();
          const downloadLink = tr.find('a[onclick*="DownloadDocumentReport"]');
          
          if (downloadLink.length > 0) {
            const name = idTdText || 'Acta de Adjudicación';
            
            let date = '';
            tr.find('td.FltContentTdAwardDetail').each((_, tdElem) => {
              const text = $(tdElem).find('.VortalSpan').text().trim();
              if (text && text !== name && text.includes('/')) {
                date = normalizeDateStr(text);
              }
            });

            const onclick = downloadLink.attr('onclick') || '';
            const docIdMatch = onclick.match(/documentId=.*?(\d+)/i) || onclick.match(/documentId=([^'&"]+)/i);
            const docId = docIdMatch ? docIdMatch[1] : '';
            const mkeyMatch = onclick.match(/mkey=([^'&"]+)/i);
            const mkey = mkeyMatch ? mkeyMatch[1] : '';
            
            let downloadUrl = '';
            if (docId && mkey) {
              downloadUrl = `https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/DownloadDocumentReport?documentId=${docId}&mkey=${mkey}`;
            }

            currentAward.reports.push({
              name,
              date,
              downloadUrl
            });
          } else if (tr.hasClass('FltTr') && !id.includes('_SubHeader') && idTdText !== 'Adjudicatario') {
            const name = idTdText;
            let valText = '';
            
            tr.find('td.FltContentTdAwardDetail').each((_, tdElem) => {
              const numSpan = $(tdElem).find('.VortalNumericSpan');
              if (numSpan.length > 0) {
                valText = numSpan.text().trim();
              }
            });
            
            if (name && name !== 'Adjudicatario') {
              currentAward.awardees.push({
                name,
                value: valText
              });
            }
          }
        }
      });
    }
    await db.saveNoticeAwards(notice.uid, awards);
    log(`Parsed ${awards.length} award records.`);

    // 3. Extract JWT Token from the script block
    let jwtToken = tokenFromConfig;
    const scriptText = $('script').text();
    const tokenMatch = scriptText.match(/var\s+token\s*=\s*['"]([^'"]+)['"]/);
    if (tokenMatch) {
      jwtToken = tokenMatch[1];
      log('Extracted JWT token from detail page HTML script.');
    } else {
      log('No token found in HTML. Using fallback token.');
    }

    // 4. Hit internal API for purchase process details
    if (jwtToken && reference) {
      const apiUrl = `https://api.comprasdominicana.gob.do:9943/api/PurchaseProcess/GetProcessByReference/${encodeURIComponent(reference)}`;
      log('Querying DGCP API for SIGEF certificates and MIPYMES data...');
      
      try {
        const apiRes = await fetchGet(apiUrl, {
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Authorization': `Bearer ${jwtToken}`,
            'Origin': 'https://comunidad.comprasdominicana.gob.do',
            'Referer': 'https://comunidad.comprasdominicana.gob.do/'
          }
        });

        if (apiRes.statusCode === 200) {
          const apiJSON = JSON.parse(apiRes.data);
          if (apiJSON && apiJSON.datos) {
            const proc = apiJSON.datos.datos_proceso || {};
            const sigefCertificates = apiJSON.datos.apropiacion_presupuestaria || [];
            
            const apiSaveData = {
              noticeUID: notice.uid,
              reference: notice.reference,
              dirigidoMipymes: proc.DIRIGIDO_MIPYMES || 'No',
              dirigidoMipymesMujeres: proc.DIRIGIDO_MIPYMES_MUJERES || 'No',
              procesoLotificado: proc.PROCESO_LOTIFICADO || 'No',
              decretoPresidencial: proc.DECRETO_PRESIDENCIAL || 'No',
              resolucionMaximaAutoridad: proc.RESOLUCION_MAXIMA_AUTORIDAD || 'No',
              organismoFinancieroExterno: proc.ORGANISMO_FINANCIERO_EXTERNO || 'No',
              marcoDecreto3122: proc.MARCO_DECRETO_3122 || 'No',
              compraVerde: proc.COMPRA_VERDE || 'No',
              compraConjunta: proc.COMPRA_CONJUNTA || 'No',
              acceptedBidsFormat: proc.ACCEPTED_BIDS_FORMAT !== undefined ? proc.ACCEPTED_BIDS_FORMAT : null,
              apropiacionPresupuestaria: sigefCertificates.map(c => ({
                codigoSigef: c.codigo_sigef,
                version: c.version_certificado,
                year: c.year_certificado,
                estado: c.estado_certificado,
                monto: c.monto_certificado,
                moneda: c.moneda,
                url: c.url_documento
              }))
            };

            await db.saveProcessApiData(apiSaveData);
            log(`Successfully synced API data. Found ${sigefCertificates.length} SIGEF certificates.`);
          } else {
            log('API response succeeded but "datos" structure was missing.');
          }
        } else {
          log(`DGCP API request returned HTTP status: ${apiRes.statusCode}`);
        }
      } catch (err) {
        log(`Failed querying DGCP API: ${err.message}`);
      }
    } else {
      log('Skipped API call: missing reference or JWT token.');
    }

    return true;
  } catch (e) {
    log(`Scraping detail error: ${e.message}`);
    return false;
  }
}

// Main background scraper runner
async function startScrapingTask(pagesCount, fallbackToken) {
  if (isScraping) {
    console.log('A scraping job is already running.');
    return;
  }

  isScraping = true;
  const runId = await db.startScrapeLog(pagesCount);
  currentRunId = runId;

  const log = (msg) => {
    console.log(`[Scraper] ${msg}`);
    db.addScrapeLogMsg(runId, msg);
  };

  log(`Starting scraper run #${runId}. Requested pages: ${pagesCount}`);

  try {
    const listUrl = 'https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/Index';
    log(`Fetching first page: ${listUrl}`);
    
    const firstPageRes = await fetchGet(listUrl);
    if (firstPageRes.statusCode !== 200) {
      throw new Error(`Failed to load index page. HTTP Status ${firstPageRes.statusCode}`);
    }

    // Parse notices from page 1
    const noticesList = parseNoticeRows(firstPageRes.data);
    log(`Parsed ${noticesList.length} notices from page 1.`);

    // Extract mkey for pagination
    let mkey = '';
    const mkeyMatch = firstPageRes.data.match(/ResultListGoToPage\?mkey=([a-f0-9_\-]+)/i);
    if (mkeyMatch) {
      mkey = mkeyMatch[1];
      log(`Extracted session mkey: ${mkey}`);
    } else {
      log('Warning: Could not parse session mkey from page 1 HTML. Pagination might fail.');
    }

    // Save initial batch of notices to database
    for (const notice of noticesList) {
      await db.saveNotice(notice);
    }
    await db.updateScrapeLog(runId, 'running', noticesList.length, 0);

    // Scrape subsequent pages using POST pagination if pagesCount > 1
    let totalNotices = [...noticesList];
    for (let pageNum = 1; pageNum < pagesCount; pageNum++) {
      if (!mkey) {
        log(`Skipping page ${pageNum + 1}: Session mkey is missing.`);
        break;
      }

      const startIdx = pageNum * 100;
      const endIdx = startIdx + 99;
      log(`Fetching page ${pageNum + 1} (Indices ${startIdx} to ${endIdx})...`);

      const paginatorUrl = `https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/ResultListGoToPage?mkey=${mkey}`;
      
      const postParams = {
        startIdx: startIdx.toString(),
        endIdx: endIdx.toString(),
        pageNumber: pageNum.toString(),
        perspective: 'All',
        initAction: 'Index',
        startIndex: '1',
        endIndex: '100',
        currentPagingStyle: '0',
        orderParam: 'RequestOnlinePublishingDateDESC',
        searchExecuted: 'False',
        categorizationSystemCode: 'UNSPSC'
      };

      try {
        const pageRes = await fetchPost(paginatorUrl, postParams);
        if (pageRes.statusCode === 200) {
          const pageNotices = parseNoticeRows(pageRes.data);
          log(`Parsed ${pageNotices.length} notices from page ${pageNum + 1}.`);
          
          if (pageNotices.length === 0) {
            log('No more rows returned. Stopping pagination.');
            break;
          }

          // Save page notices
          for (const notice of pageNotices) {
            await db.saveNotice(notice);
            // Deduplicate if already present
            if (!totalNotices.some(n => n.uid === notice.uid)) {
              totalNotices.push(notice);
            }
          }

          // Update mkey from the pagination response just in case it rotates
          const newMkeyMatch = pageRes.data.match(/ResultListGoToPage\?mkey=([a-f0-9_\-]+)/i);
          if (newMkeyMatch) {
            mkey = newMkeyMatch[1];
          }

          await db.updateScrapeLog(runId, 'running', totalNotices.length, 0);
        } else {
          log(`Failed pagination request. Status: ${pageRes.statusCode}`);
          break;
        }
      } catch (err) {
        log(`Error fetching page ${pageNum + 1}: ${err.message}`);
        break;
      }
    }

    log(`Total list notices loaded: ${totalNotices.length}. Beginning detail sync for each notice...`);

    // Scrape details for all parsed notices
    let processedCount = 0;
    for (const notice of totalNotices) {
      // Check if notice already exists in database
      const dbNotice = await db.getNoticeBasic(notice.uid);
      
      // Conditions to skip detailed scraping:
      // 1. Notice exists, details have been scraped (detail_scraped = 1)
      // 2. The phase AND state in DB match what we got from the list (meaning no updates have happened)
      // 3. If it is in an awarded state, we must have at least one award parsed in the database.
      const isAwardedState = (notice.state || '').toLowerCase().includes('adjudicado') || 
                             (notice.state || '').toLowerCase().includes('celebrado') ||
                             (dbNotice && dbNotice.state && (dbNotice.state.toLowerCase().includes('adjudicado') || dbNotice.state.toLowerCase().includes('celebrado')));
      const hasAwardsIfAwarded = !isAwardedState || (dbNotice && dbNotice.award_count && dbNotice.award_count > 0);

      if (dbNotice && dbNotice.detail_scraped === 1 && 
          dbNotice.state === notice.state && 
          dbNotice.phase === notice.phase &&
          hasAwardsIfAwarded) {
        log(`Notice ${notice.reference || notice.uid} is already up-to-date in DB. Skipping detail sync.`);
        processedCount++;
        await db.updateScrapeLog(runId, 'running', totalNotices.length, processedCount);
        continue;
      }

      log(`[Progress ${processedCount + 1}/${totalNotices.length}] Syncing details for notice: ${notice.reference}`);
      const success = await scrapeSingleNoticeDetails(runId, notice, fallbackToken);
      if (success) {
        processedCount++;
      }
      // Update logs in real time
      await db.updateScrapeLog(runId, 'running', totalNotices.length, processedCount);
      
      // Add a 1.5-second delay between requests to be polite to the server
      await new Promise(r => setTimeout(r, 1500));
    }

    log(`Scraping sync completed successfully! Processed ${processedCount} of ${totalNotices.length} notices.`);
    await db.updateScrapeLog(runId, 'completed', totalNotices.length, processedCount);

  } catch (error) {
    log(`Critical Scraper Failure: ${error.message}`);
    await db.updateScrapeLog(runId, 'failed', 0, 0);
  } finally {
    isScraping = false;
    currentRunId = null;
  }
}

module.exports = {
  // Trigger scraping task in background
  runScraper(pagesCount = 1, fallbackToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEiLCJ1c2VybmFtZSI6ImFkbWluIiwicGFzc3dvcmQiOiI4elVqc0FKeGw3VUVkZmRzc3dGTkY5S2FzYnVTTjJPN0ZyWGQiLCJuYmYiOjE3MTY4MjgzODcsImV4cCI6MTcxNzQzMzE4NywiaWF0IjoxNzE2ODI4Mzg3fQ.p6MAZHZFpvYCnRtPWnDyIdjkHUZR692VrsE_7GUQSM0') {
    if (isScraping) return false;
    // Execute async in background without waiting
    startScrapingTask(pagesCount, fallbackToken);
    return true;
  },
  
  // Force sync details of a single notice in real-time
  async syncSingleNotice(uid, fallbackToken) {
    const notice = await db.getNoticeBasic(uid) || { uid };
    const token = fallbackToken || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEiLCJ1c2VybmFtZSI6ImFkbWluIiwicGFzc3dvcmQiOiI4elVqc0FKeGw3VUVkZmRzc3dGTkY5S2FzYnVTTjJPN0ZyWGQiLCJuYmYiOjE3MTY4MjgzODcsImV4cCI6MTcxNzQzMzE4NywiaWF0IjoxNzE2ODI4Mzg3fQ.p6MAZHZFpvYCnRtPWnDyIdjkHUZR692VrsE_7GUQSM0';
    return await scrapeSingleNoticeDetails(null, notice, token);
  },
  
  // Get active status
  getStatus() {
    return {
      isScraping,
      currentRunId
    };
  }
};

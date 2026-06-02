const express = require('express');
const cors = require('cors');
const db = require('./db');
const scraper = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Helper function to format service details neatly
function formatServiceDetail(detail) {
  const { notice, details, schedules, apiData, documents, items, awards } = detail;
  return {
    uid: notice.uid,
    reference: notice.reference,
    buyer_name: notice.buyer_name,
    description: notice.description,
    phase: notice.phase,
    state: notice.state,
    publish_date: notice.publish_date,
    submission_date: notice.submission_date,
    base_price: notice.base_price,
    base_price_num: notice.base_price_num,
    scraped_at: notice.scraped_at,
    detail_scraped: notice.detail_scraped,
    
    // Detailed contract information
    contract_details: details ? {
      procedure_type: details.procedure_type,
      type_of_contract: details.type_of_contract,
      subtype_of_contract: details.subtype_of_contract,
      place_of_work: details.place_of_work,
      budget_total_value: details.budget_total_value,
      budget_currency: details.budget_currency,
      expenditure_objective: details.expenditure_objective,
      source_of_funds: details.source_of_funds,
      manual_integration: details.manual_integration,
      snip: details.snip === 'Snip',
      snip_code: details.snip_code || null
    } : null,
    
    // Scheduled milestones / timeline
    schedules: (schedules || []).map(s => ({
      label: s.label,
      date: s.date_str
    })),
    
    // Contract documents
    documents: (documents || []).map(d => ({
      name: d.name,
      type: d.type,
      download_url: d.download_url
    })),
    
    // Questionnaire / Line items
    items: (items || []).map(i => ({
      index: i.item_index,
      category: i.category,
      account: i.account,
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unit_price: i.unit_price,
      total_price: i.total_price
    })),
    
    // DGCP Internal API Info
    dgcp_api_data: apiData ? {
      dirigido_mipymes: apiData.dirigido_mipymes,
      dirigido_mipymes_mujeres: apiData.dirigido_mipymes_mujeres,
      proceso_lotificado: apiData.proceso_lotificado,
      decreto_presidencial: apiData.decreto_presidencial,
      resolucion_maxima_autoridad: apiData.resolucion_maxima_autoridad,
      organismo_financiero_externo: apiData.organismo_financiero_externo,
      marco_decreto_3122: apiData.marco_decreto_3122,
      compra_verde: apiData.compra_verde,
      compra_conjunta: apiData.compra_conjunta,
      accepted_bids_format: apiData.accepted_bids_format,
      apropiacion_presupuestaria: apiData.apropiacion_presupuestaria || []
    } : null,

    // Selection / Award details
    awards: (awards || []).map(aw => ({
      id: aw.award_id,
      date: aw.award_date,
      value: aw.award_value,
      value_num: aw.award_value_num,
      reports: (aw.reports || []).map(r => ({
        name: r.name,
        date: r.date,
        download_url: r.download_url
      })),
      awardees: (aw.awardees || []).map(e => ({
        name: e.name,
        value: e.value,
        value_num: e.value_num
      }))
    }))
  };
}

// 1. Get services (100 items by default, with pagination metadata)
app.get('/api/services', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const search = req.query.search || '';

    const result = await db.getNotices({
      search,
      page,
      limit
    });

    const total = result.total;
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      meta: {
        total,
        page,
        limit,
        totalPages
      },
      data: result.data.map(notice => ({
        uid: notice.uid,
        country: notice.country,
        buyer_name: notice.buyer_name,
        reference: notice.reference,
        description: notice.description,
        phase: notice.phase,
        publish_date: notice.publish_date,
        submission_date: notice.submission_date,
        base_price: notice.base_price,
        base_price_num: notice.base_price_num,
        state: notice.state,
        scraped_at: notice.scraped_at,
        detail_scraped: notice.detail_scraped,
        dirigido_mipymes: notice.dirigido_mipymes,
        dirigido_mipymes_mujeres: notice.dirigido_mipymes_mujeres,
        snip: notice.snip,
        total_awarded: notice.total_awarded,
        contract_details: {
          procedure_type: notice.procedure_type || null,
          type_of_contract: notice.type_of_contract || null
        }
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Get detailed service data by Reference (process code) or noticeUID
app.get('/api/services/:referenceOrUid', async (req, res) => {
  try {
    const { referenceOrUid } = req.params;
    let detail = await db.getNoticeDetailByRefOrUid(referenceOrUid);
    
    if (!detail) {
      // If it looks like a Notice UID (DO1.NTC.xxxx), we can try to fetch it directly from the portal
      if (/^DO1\.NTC\.\d+$/i.test(referenceOrUid)) {
        try {
          console.log(`Notice UID ${referenceOrUid} not in database. Fetching directly from portal...`);
          await scraper.syncSingleNotice(referenceOrUid);
          detail = await db.getNoticeDetailByRefOrUid(referenceOrUid);
        } catch (syncErr) {
          console.warn(`Failed direct fetch of notice ${referenceOrUid}: ${syncErr.message}`);
        }
      }
      
      if (!detail) {
        return res.status(404).json({ success: false, message: `Procurement process with code/UID "${referenceOrUid}" not found.` });
      }
    }

    // Auto-sync if details are missing or have never been scraped
    if (!detail.details || detail.notice.detail_scraped === 0) {
      try {
        console.log(`Auto-syncing details for ${detail.notice.reference}...`);
        await scraper.syncSingleNotice(detail.notice.uid);
        // Reload detail from DB after sync
        detail = await db.getNoticeDetailByRefOrUid(referenceOrUid);
      } catch (syncErr) {
        console.warn(`Failed to auto-sync details for ${referenceOrUid}: ${syncErr.message}`);
      }
    }

    res.json({
      success: true,
      data: formatServiceDetail(detail)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Force synchronize a single notice detail in real-time
app.post('/api/services/:referenceOrUid/sync', async (req, res) => {
  try {
    const { referenceOrUid } = req.params;
    const { fallbackToken } = req.body;
    
    // Retrieve the basic info to get the notice UID
    let notice = await db.getNoticeBasic(referenceOrUid);
    if (!notice && /^DO1\.NTC\.\d+$/i.test(referenceOrUid)) {
      notice = { uid: referenceOrUid };
    }

    if (!notice) {
      return res.status(404).json({ success: false, message: `Procurement process with code/UID "${referenceOrUid}" not found.` });
    }

    const success = await scraper.syncSingleNotice(notice.uid, fallbackToken);
    if (success) {
      const updatedDetail = await db.getNoticeDetail(notice.uid);
      res.json({
        success: true,
        message: 'Service details synchronized successfully.',
        data: formatServiceDetail(updatedDetail)
      });
    } else {
      res.status(500).json({ success: false, message: 'Failed to synchronize service details.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Background full scraper trigger
app.post('/api/scrape', (req, res) => {
  try {
    const { pages, fallbackToken } = req.body;
    const pageNum = parseInt(pages) || 1;
    
    const started = scraper.runScraper(pageNum, fallbackToken);
    if (started) {
      res.json({ success: true, message: 'Scraping job started successfully.' });
    } else {
      res.status(400).json({ success: false, message: 'A scraping job is already in progress.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Get scraper status
app.get('/api/status', (req, res) => {
  try {
    const status = scraper.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Get latest scraper run logs
app.get('/api/logs/latest', async (req, res) => {
  try {
    const log = await db.getLatestScrapeLog();
    res.json({ success: true, log });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// Helper to clean company names for matching
function cleanCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(srl|sas|sa|eirl|grup|group)$/g, '')
    .trim();
}

// 7. Get suppliers with computed contract awards (paginated)
app.get('/api/suppliers', async (req, res) => {
  try {
    const search = req.query.search || '';
    const mipyme = req.query.mipyme || '';
    const genero = req.query.genero || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;

    // Fetch database metrics for high-level stats cards
    const dbStats = await db.getSupplierStats();

    // Fetch paginated suppliers
    const { total, rows } = await db.getSuppliersPaginated({ search, mipyme, genero, page, limit });

    // Join awards for this specific page (fast!)
    const awardees = await db.getNoticeAwardees();
    const awardeeMap = new Map();
    awardees.forEach(a => {
      const cleaned = cleanCompanyName(a.awardee_name);
      if (!cleaned) return;
      if (!awardeeMap.has(cleaned)) {
        awardeeMap.set(cleaned, []);
      }
      awardeeMap.get(cleaned).push(a);
    });

    const result = rows.map(s => {
      const cleaned = cleanCompanyName(s.razon_social);
      const matches = awardeeMap.get(cleaned) || [];
      
      const total_value = matches.reduce((sum, m) => sum + (m.award_value_num || 0), 0);
      const awards = matches.map(m => ({
        notice_uid: m.notice_uid,
        notice_reference: m.notice_reference,
        notice_description: m.notice_description,
        notice_publish_date: m.notice_publish_date,
        notice_state: m.notice_state,
        award_date: m.award_date,
        value: m.award_value,
        value_num: m.award_value_num
      }));

      return {
        rpe: s.rpe,
        razon_social: s.razon_social,
        numero_documento: s.numero_documento,
        tipo_documento: s.tipo_documento,
        estado_rpe: s.estado_rpe,
        genero: s.genero,
        tipo_persona: s.tipo_persona,
        forma_juridica: s.forma_juridica,
        mipyme: s.mipyme,
        certificado_micm: s.certificado_micm,
        clasificacion: s.clasificacion,
        clasificacion_empresarial: s.clasificacion_empresarial,
        provincia: s.provincia,
        municipio: s.municipio,
        correo: s.correo,
        telefono: s.telefono,
        direccion: s.direccion,
        contacto: s.contacto,
        observacion: s.observacion,
        
        // Computed stats
        award_count: awards.length,
        total_awarded: total_value,
        awards: awards
      };
    });

    res.json({ 
      success: true, 
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      },
      stats: {
        total: dbStats.total,
        mipymeCount: dbStats.mipymeCount,
        femaleCount: dbStats.femaleCount
      },
      data: result 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Batch import State Suppliers
app.post('/api/suppliers/import', async (req, res) => {
  try {
    const { suppliers } = req.body;
    if (!Array.isArray(suppliers)) {
      return res.status(400).json({ success: false, message: 'suppliers body must be an array' });
    }
    const count = await db.saveSuppliers(suppliers);
    res.json({ success: true, message: `Successfully imported ${count} suppliers.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Batch import Historical Processes
app.post('/api/processes/import', async (req, res) => {
  try {
    const { processes } = req.body;
    if (!Array.isArray(processes)) {
      return res.status(400).json({ success: false, message: 'processes body must be an array' });
    }
    
    let count = 0;
    for (const proc of processes) {
      if (proc.reference && proc.supplier_name) {
        await db.saveImportedProcess(proc);
        count++;
      }
    }
    res.json({ success: true, message: `Successfully imported ${count} historical processes.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. Collusion Analysis
app.get('/api/analysis/collusion', async (req, res) => {
  try {
    const data = await db.getCollusionAnalysis();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 11. Contract Splitting Analysis
app.get('/api/analysis/splitting', async (req, res) => {
  try {
    const data = await db.getSplittingAnalysis();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 12. Directed Bidding Analysis
app.get('/api/analysis/directed-bidding', async (req, res) => {
  try {
    const data = await db.getDirectedBiddingAnalysis();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start listening
app.listen(PORT, () => {
  console.log(`Express API-Only Server listening on port ${PORT}`);
  console.log(`Database engine is: ${db.getEngine()}`);
});

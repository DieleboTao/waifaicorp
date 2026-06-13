// server.cjs – WaifaiCorp Professional Legal Assistant (PRODUCTION READY)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ ENVIRONMENT VARIABLES (SET ON RENDER) ============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GROQ_API_KEY) {
  console.error("❌ Missing required environment variables.");
  console.error("Please set: SUPABASE_URL, SUPABASE_ANON_KEY, GROQ_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const groq = new Groq({ apiKey: GROQ_API_KEY });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session store for deterministic assistant
const sessions = new Map();

// ============ AUTH ROUTES ============
app.post('/api/company/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const { data: existing } = await supabase.from('companies').select('id').eq('email', email).single();
    if (existing) return res.status(400).json({ error: 'Company already exists' });
    const companyId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    await supabase.from('companies').insert([{
      id: companyId,
      name,
      email,
      password: hashedPassword,
      subscription_status: 'free',
      created_at: new Date().toISOString()
    }]);
    res.json({ success: true, companyId, companyName: name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/company/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: company } = await supabase.from('companies').select('*').eq('email', email).single();
    if (!company) return res.status(401).json({ error: 'Company not found' });
    const valid = await bcrypt.compare(password, company.password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });
    res.json({ success: true, companyId: company.id, companyName: company.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/company/info/:companyId', async (req, res) => {
  try {
    const { data: company } = await supabase.from('companies').select('subscription_status').eq('id', req.params.companyId).single();
    const { data: contracts } = await supabase.from('contracts').select('id').eq('company_id', req.params.companyId);
    res.json({ subscription_status: company?.subscription_status, contracts_used: contracts?.length || 0, remaining_free: 'unlimited', is_premium: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ DETERMINISTIC ASSISTANT (13 QUESTIONS) ============
const steps = [
  { key: 'userRole', question: 'Are you acting as the **Provider** (delivering services/goods) or the **Client** (receiving)? (Answer "provider" or "client")' },
  { key: 'counterpartyType', question: 'Is the other party an **individual** or a **company**? (Answer "individual" or "company")' },
  { key: 'counterpartyName', question: 'Full legal name of the other party (for a company, registered name):' },
  { key: 'counterpartyRegNo', question: 'If a company, registration number. If individual, type "N/A":' },
  { key: 'counterpartyVat', question: 'VAT number (if none, type "N/A"):' },
  { key: 'counterpartyAddress', question: 'Full physical address of the other party:' },
  { key: 'counterpartyContact', question: 'Contact email and phone number (e.g., john@example.com, +27 12 345 6789):' },
  { key: 'counterpartySignatory', question: 'Who will sign on behalf of the other party? (Full name and title):' },
  { key: 'contractType', question: 'Type of contract (e.g., Service Agreement, NDA, Employment Contract):' },
  { key: 'scope', question: 'Detailed description of services, goods, or obligations:' },
  { key: 'duration', question: 'Duration or term (e.g., "6 months from signing", "one-off"):' },
  { key: 'paymentTerms', question: 'Complete payment terms (amount, currency, due dates, milestones, late fees):' },
  { key: 'specialConditions', question: 'Special conditions, termination clauses, or additional provisions (if none, type "None"):' }
];

app.post('/api/ai/assistant', async (req, res) => {
  try {
    const { sessionId, message, companyId } = req.body;
    if (!sessionId || !companyId) return res.status(400).json({ error: 'Missing sessionId or companyId' });

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { step: 0, answers: {} });
    }
    const session = sessions.get(sessionId);
    let { step, answers } = session;

    if (!message) {
      return res.json({ action: 'ask', question: steps[0].question });
    }

    const currentStep = steps[step];
    answers[currentStep.key] = message.trim();
    step++;
    session.step = step;
    sessions.set(sessionId, session);

    if (step < steps.length) {
      return res.json({ action: 'ask', question: steps[step].question });
    }

    // All answers collected – generate professional contract
    const { data: company } = await supabase.from('companies').select('name, email').eq('id', companyId).single();
    const userCompany = company.name;
    const userEmail = company.email;

    const isProvider = answers.userRole === 'provider';
    const providerName = isProvider ? userCompany : answers.counterpartyName;
    const clientName = isProvider ? answers.counterpartyName : userCompany;
    const providerEmail = isProvider ? userEmail : (answers.counterpartyContact.match(/\S+@\S+/) || [''])[0];
    const clientEmail = isProvider ? (answers.counterpartyContact.match(/\S+@\S+/) || [''])[0] : userEmail;

    const providerDetails = {
      name: providerName,
      email: providerEmail,
      address: isProvider ? 'Registered address on file' : answers.counterpartyAddress,
      regNo: isProvider ? 'N/A' : answers.counterpartyRegNo,
      vat: isProvider ? 'N/A' : answers.counterpartyVat,
      signatory: isProvider ? 'Authorised Representative' : answers.counterpartySignatory
    };
    const clientDetails = {
      name: clientName,
      email: clientEmail,
      address: isProvider ? answers.counterpartyAddress : 'Registered address on file',
      regNo: isProvider ? answers.counterpartyRegNo : 'N/A',
      vat: isProvider ? answers.counterpartyVat : 'N/A',
      signatory: isProvider ? answers.counterpartySignatory : 'Authorised Representative'
    };

    // Strong legal prompt – Llama 3.3 70B
    const prompt = `You are a senior South African contract lawyer. Draft a comprehensive, legally binding ${answers.contractType} agreement. Each clause MUST be a detailed paragraph of at least 4-6 sentences. Include: Parties (with addresses), Recitals (background), Definitions, Scope of Services (detailed), Term and Termination, Payment Terms (detailed), Warranties and Liability, Dispute Resolution (arbitration in Johannesburg), General Provisions (entire agreement, amendment, governing law), Signatures (with date and place lines).

Specific information:
PROVIDER: ${providerDetails.name} (${providerDetails.regNo !== 'N/A' ? 'Reg: ' + providerDetails.regNo : 'Individual'})
Address: ${providerDetails.address}
Email: ${providerDetails.email}
Signatory: ${providerDetails.signatory}

CLIENT: ${clientDetails.name} (${clientDetails.regNo !== 'N/A' ? 'Reg: ' + clientDetails.regNo : 'Individual'})
Address: ${clientDetails.address}
Email: ${clientDetails.email}
Signatory: ${clientDetails.signatory}

SCOPE: ${answers.scope}
TERM: ${answers.duration}
PAYMENT: ${answers.paymentTerms}
SPECIAL CONDITIONS: ${answers.specialConditions}

Return ONLY valid JSON with the structure below. Do not use placeholders. Ensure each clause content is a full paragraph of multiple sentences.

{
  "title": "${answers.contractType} between ${providerDetails.name} and ${clientDetails.name}",
  "clauses": [
    {"title": "1. PARTIES", "content": "This Agreement is made on this date by and between ${providerDetails.name} ('Provider'), with address at ${providerDetails.address}, and ${clientDetails.name} ('Client'), with address at ${clientDetails.address}."},
    {"title": "2. RECITALS", "content": "WHEREAS the Provider offers certain services and the Client wishes to engage the Provider; and WHEREAS both parties intend to be legally bound; and WHEREAS this Agreement sets forth the terms and conditions of their relationship."},
    {"title": "3. DEFINITIONS", "content": "In this Agreement, 'Services' means the activities described in Clause 4; 'Term' means the period set out in Clause 5; 'Fees' means the consideration under Clause 6. Any reference to a clause refers to a clause of this Agreement."},
    {"title": "4. SCOPE OF SERVICES", "content": "${answers.scope} The Provider shall perform the Services with reasonable care and skill, in accordance with industry standards. Any changes to the scope must be agreed in writing and may result in additional fees. The Provider may subcontract but remains liable for subcontracted work."},
    {"title": "5. TERM AND TERMINATION", "content": "This Agreement shall commence on the date of signing and shall continue for ${answers.duration}. Either party may terminate this Agreement on 30 days written notice. Termination shall not affect accrued rights or obligations, including payment for Services rendered prior to termination. ${answers.specialConditions.includes('None') ? '' : 'Additional termination provisions: ' + answers.specialConditions}"},
    {"title": "6. PAYMENT TERMS", "content": "${answers.paymentTerms} Invoices shall be issued and are payable within 15 days of receipt. Late payments incur interest at 2% per month, calculated daily. All amounts are in South African Rand. The Client shall pay all taxes, duties, and levies imposed by any authority."},
    {"title": "7. WARRANTIES AND LIABILITY", "content": "The Provider warrants that the Services will be performed in a professional manner. Neither party excludes liability for death or personal injury caused by its negligence. To the maximum extent permitted by law, the Provider's total liability shall not exceed the total Fees paid by the Client."},
    {"title": "8. DISPUTE RESOLUTION", "content": "Any dispute arising out of or in connection with this Agreement shall first be attempted through good faith negotiations. If unresolved within 14 days, the dispute shall be referred to arbitration in Johannesburg in accordance with the Arbitration Foundation of Southern Africa (AFSA) rules. The arbitrator's decision shall be final and binding. Each party shall bear its own legal costs."},
    {"title": "9. GENERAL PROVISIONS", "content": "This Agreement constitutes the entire agreement between the parties and supersedes all prior communications. No amendment shall be effective unless in writing signed by both parties. Governing law is the law of the Republic of South Africa. If any provision is found unenforceable, the remainder shall continue in full force and effect."},
    {"title": "10. SIGNATURES", "content": "IN WITNESS WHEREOF the parties have executed this Agreement as of the date first written above.\n\nProvider: ${providerDetails.signatory} (Signature) _________________\nDate: ___________\nPlace: ___________\n\nClient: ${clientDetails.signatory} (Signature) _________________\nDate: ___________\nPlace: ___________"}
  ]
}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });

    let contractData;
    try {
      const content = completion.choices[0].message.content;
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      contractData = JSON.parse(jsonStr);
    } catch (e) {
      contractData = {
        title: `${answers.contractType} between ${providerDetails.name} and ${clientDetails.name}`,
        clauses: [
          { title: "1. PARTIES", content: `${providerDetails.name} and ${clientDetails.name}` },
          { title: "2. SCOPE", content: answers.scope },
          { title: "3. TERM", content: answers.duration },
          { title: "4. PAYMENT", content: answers.paymentTerms },
          { title: "5. GOVERNING LAW", content: "South Africa" },
          { title: "6. SIGNATURES", content: `Provider: ${providerDetails.signatory}\nClient: ${clientDetails.signatory}` }
        ]
      };
    }

    const parties = [
      { name: providerDetails.name, email: providerDetails.email, role: 'Provider', signed: false },
      { name: clientDetails.name, email: clientDetails.email, role: 'Client', signed: false }
    ];

    sessions.delete(sessionId);
    res.json({ action: 'generate', contract: { title: contractData.title, parties, clauses: contractData.clauses, conditions: {} } });
  } catch (err) {
    console.error('Assistant error:', err);
    if (req.body.sessionId) sessions.delete(req.body.sessionId);
    res.status(500).json({ action: 'ask', question: 'System error. Please start a new contract.' });
  }
});

// ============ CONTRACT MANAGEMENT ============
app.post('/api/contracts', async (req, res) => {
  try {
    const { title, clauses, parties, conditions, companyId, autoPublish } = req.body;
    const contractId = uuidv4();
    const qrToken = uuidv4().replace(/-/g, '').substring(0, 16);
    const status = autoPublish ? 'client_review' : 'draft';
    const qrUrl = `${BASE_URL}/public/contract/${qrToken}`;
    await supabase.from('contracts').insert([{
      id: contractId,
      company_id: companyId,
      title,
      clauses: JSON.stringify(clauses),
      parties: JSON.stringify(parties),
      conditions: JSON.stringify(conditions || {}),
      status,
      qr_token: qrToken,
      created_at: new Date().toISOString()
    }]);
    res.json({ success: true, contractId, qrUrl, qrToken });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/company/contracts/:companyId', async (req, res) => {
  try {
    const { data: contracts } = await supabase.from('contracts').select('*').eq('company_id', req.params.companyId).order('created_at', { ascending: false });
    const { data: signatures } = await supabase.from('signatures').select('*');
    const { data: satisfaction } = await supabase.from('satisfaction_log').select('*');
    const parsed = contracts.map(c => {
      const parties = JSON.parse(c.parties || '[]');
      const updatedParties = parties.map(p => ({
        ...p,
        signed: signatures?.some(s => s.contract_id === c.id && s.signer_email === p.email) || false
      }));
      return {
        ...c,
        clauses: JSON.parse(c.clauses || '[]'),
        parties: updatedParties,
        signatures_count: signatures?.filter(s => s.contract_id === c.id).length || 0,
        satisfied_count: satisfaction?.filter(s => s.contract_id === c.id).length || 0
      };
    });
    res.json(parsed);
  } catch (err) { res.json([]); }
});

app.get('/api/contracts/:contractId/qr', async (req, res) => {
  try {
    const { data: contract } = await supabase.from('contracts').select('qr_token').eq('id', req.params.contractId).single();
    if (!contract) return res.status(404).json({ error: 'Not found' });
    const qrUrl = `${BASE_URL}/public/contract/${contract.qr_token}`;
    const qrCode = await QRCode.toDataURL(qrUrl);
    res.json({ qrCode, qrUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ DIRECT SIGNING (WITH SIGNATURE + SELFIE) ============
app.get('/api/client/sign-direct/:qrToken', async (req, res) => {
  const { qrToken } = req.params;
  const { data: contract } = await supabase
    .from('contracts')
    .select('*, companies(name)')
    .eq('qr_token', qrToken)
    .single();
  if (!contract) return res.status(404).json({ error: 'Contract not found or expired' });
  res.json({
    contract: {
      ...contract,
      clauses: JSON.parse(contract.clauses),
      parties: JSON.parse(contract.parties),
      company_name: contract.companies?.name
    }
  });
});

app.post('/api/client/sign-direct/:qrToken', async (req, res) => {
  const { qrToken } = req.params;
  const { signerEmail, signatureData, selfieData } = req.body;
  const { data: contract } = await supabase.from('contracts').select('*').eq('qr_token', qrToken).single();
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  await supabase.from('signatures').insert([{
    id: uuidv4(),
    contract_id: contract.id,
    signer_email: signerEmail,
    signature_data: signatureData || 'digitally agreed',
    selfie_data: selfieData || null
  }]);

  const parties = JSON.parse(contract.parties);
  const { data: signatures } = await supabase.from('signatures').select('id').eq('contract_id', contract.id);
  if (signatures.length === parties.length) {
    await supabase.from('contracts').update({ status: 'signed', executed_at: new Date().toISOString() }).eq('id', contract.id);
  }
  res.json({ success: true, contractId: contract.id });
});

// ============ STATIC HTML ROUTES ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/client-view.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client-view.html')));
app.get('/public-view.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'public-view.html')));
app.get('/public/contract/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'public-view.html')));

app.listen(PORT, () => {
  console.log(`✅ Server running on ${BASE_URL}`);
  console.log(`Professional legal assistant ready – using Llama 3.3 70B`);
});
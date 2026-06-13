// server.cjs – WaifaiCorp Professional Legal Assistant (Full Production)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const { Resend } = require('resend');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GROQ_API_KEY) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const groq = new Groq({ apiKey: GROQ_API_KEY });
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session store for deterministic assistant
const sessions = new Map();
const otpStore = new Map(); // email -> { code, expires }

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

// ============ OTP EMAIL VERIFICATION ============
app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!resend) return res.status(500).json({ error: 'Email service not configured' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(email, { code, expires: Date.now() + 10 * 60 * 1000 });
  try {
    await resend.emails.send({
      from: 'WaifaiCorp <noreply@waifaicorp.com>',
      to: [email],
      subject: 'Your verification code',
      html: `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 10 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/verify-otp', (req, res) => {
  const { email, code } = req.body;
  const record = otpStore.get(email);
  if (!record || record.code !== code || record.expires < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  otpStore.delete(email);
  res.json({ success: true });
});

// ============ DETERMINISTIC ASSISTANT (same as before) ============
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

    // Generate contract
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

    const prompt = `You are a senior South African contract lawyer. Draft a comprehensive, legally binding ${answers.contractType} agreement. Each clause MUST be a detailed paragraph of at least 4-6 sentences. Include: Parties (with addresses), Recitals, Definitions, Scope, Term, Payment, Warranties, Dispute Resolution (arbitration), General Provisions, Signatures.

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

Return ONLY valid JSON with exactly these 10 clauses. Use full paragraphs.
{
  "title": "${answers.contractType} between ${providerDetails.name} and ${clientDetails.name}",
  "clauses": [
    {"title": "1. PARTIES", "content": "This Agreement is made on this date by and between ${providerDetails.name} ('Provider') and ${clientDetails.name} ('Client')."},
    {"title": "2. RECITALS", "content": "WHEREAS the Provider offers services and the Client wishes to engage the Provider; ..."},
    {"title": "3. DEFINITIONS", "content": "Definitions of key terms."},
    {"title": "4. SCOPE OF SERVICES", "content": "${answers.scope}"},
    {"title": "5. TERM AND TERMINATION", "content": "${answers.duration}. Termination provisions: ${answers.specialConditions.includes('None') ? '30 days notice' : answers.specialConditions}"},
    {"title": "6. PAYMENT TERMS", "content": "${answers.paymentTerms}"},
    {"title": "7. WARRANTIES AND LIABILITY", "content": "Warranties and limitation of liability."},
    {"title": "8. DISPUTE RESOLUTION", "content": "Arbitration in Johannesburg under AFSA rules."},
    {"title": "9. GENERAL PROVISIONS", "content": "Entire agreement, governing law (South Africa)."},
    {"title": "10. SIGNATURES", "content": "Provider: ${providerDetails.signatory} (Signature) ______\nClient: ${clientDetails.signatory} (Signature) ______"}
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
      contractData = { title: `${answers.contractType} between ${providerDetails.name} and ${clientDetails.name}`, clauses: [] };
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
    const parsed = contracts.map(c => {
      let parties = JSON.parse(c.parties || '[]');
      parties = parties.map(p => ({
        ...p,
        signed: signatures?.some(s => s.contract_id === c.id && s.signer_email === p.email) || false
      }));
      return {
        ...c,
        clauses: JSON.parse(c.clauses || '[]'),
        parties,
        signatures_count: signatures?.filter(s => s.contract_id === c.id).length || 0
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

// ============ DELETE CONTRACT ============
app.delete('/api/contracts/:contractId', async (req, res) => {
  const { contractId } = req.params;
  const { companyId } = req.body;
  const { data: contract } = await supabase.from('contracts').select('company_id').eq('id', contractId).single();
  if (!contract || contract.company_id !== companyId) return res.status(403).json({ error: 'Unauthorized' });
  await supabase.from('contracts').delete().eq('id', contractId);
  res.json({ success: true });
});

// ============ PDF DOWNLOAD ============
app.get('/api/contracts/:contractId/pdf', async (req, res) => {
  try {
    const { contractId } = req.params;
    const { data: contract } = await supabase.from('contracts').select('*').eq('id', contractId).single();
    if (!contract) return res.status(404).json({ error: 'Not found' });
    const clauses = JSON.parse(contract.clauses);
    const doc = new PDFDocument();
    res.setHeader('Content-Disposition', `attachment; filename="${contract.title}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(16).text(contract.title, { align: 'center' });
    doc.moveDown();
    clauses.forEach(clause => {
      doc.fontSize(12).text(clause.title, { underline: true });
      doc.text(clause.content);
      doc.moveDown();
    });
    doc.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ DIRECT SIGNING (with OTP, email notification, parties update) ============
app.get('/api/client/sign-direct/:qrToken', async (req, res) => {
  const { qrToken } = req.params;
  const { data: contract } = await supabase
    .from('contracts')
    .select('*, companies(name, email)')
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
  const { data: contract } = await supabase.from('contracts').select('*, companies(name, email)').eq('qr_token', qrToken).single();
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  // Insert signature with selfie
  await supabase.from('signatures').insert([{
    id: uuidv4(),
    contract_id: contract.id,
    signer_email: signerEmail,
    signature_data: signatureData || 'digitally agreed',
    selfie_data: selfieData || null
  }]);

  // Update parties array to mark this signer as signed
  let parties = JSON.parse(contract.parties);
  const updatedParties = parties.map(p => 
    p.email === signerEmail ? { ...p, signed: true } : p
  );
  await supabase.from('contracts').update({ parties: JSON.stringify(updatedParties) }).eq('id', contract.id);

  // Check if all parties have signed
  const { data: signatures } = await supabase.from('signatures').select('id').eq('contract_id', contract.id);
  if (signatures.length === updatedParties.length) {
    await supabase.from('contracts').update({ status: 'signed', executed_at: new Date().toISOString() }).eq('id', contract.id);
  }

  // Send email notifications (if email service configured)
  if (resend) {
    const companyEmail = contract.companies.email;
    const signerName = updatedParties.find(p => p.email === signerEmail)?.name || signerEmail;
    await resend.emails.send({
      from: 'WaifaiCorp <noreply@waifaicorp.com>',
      to: [signerEmail],
      subject: `You signed: ${contract.title}`,
      html: `<p>Thank you for signing the contract <strong>${contract.title}</strong>.</p><p>View it here: ${BASE_URL}/public/contract/${qrToken}</p>`
    });
    await resend.emails.send({
      from: 'WaifaiCorp <noreply@waifaicorp.com>',
      to: [companyEmail],
      subject: `Contract signed: ${contract.title}`,
      html: `<p>${signerName} (${signerEmail}) has signed the contract <strong>${contract.title}</strong>.</p><p>View it in your dashboard: ${BASE_URL}/dashboard.html</p>`
    });
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
  console.log(`Professional legal assistant ready – full features`);
});
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json()); 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
  res.json({ mensagem: "Servidor rodando!" });
});

// ==========================================
// AUTENTICAÇÃO
// ==========================================

app.post('/api/auth/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });

  try {
    const usuarioExiste = await pool.query('SELECT * FROM membros WHERE email = $1', [email]);
    if (usuarioExiste.rows.length > 0) return res.status(400).json({ erro: "Este e-mail já está cadastrado." });

    const convite = await pool.query('SELECT * FROM convites WHERE email_convidado = $1 AND status = $2', [email, 'pendente']);
    let empresaId;
    
    if (convite.rows.length > 0) {
      empresaId = convite.rows[0].empresa_id;
      await pool.query('UPDATE convites SET status = $1 WHERE id = $2', ['aceito', convite.rows[0].id]);
    } else {
      const novaEmpresa = await pool.query('INSERT INTO empresas (nome_fantasia) VALUES ($1) RETURNING id', [`Empresa de ${nome}`]);
      empresaId = novaEmpresa.rows[0].id;
    }

    const cargo = convite.rows.length > 0 ? 'ajudante' : 'gestor';
    const novoUsuario = await pool.query(
      'INSERT INTO membros (empresa_id, user_id, nome, email, cargo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [empresaId, '00000000-0000-0000-0000-000000000000', nome, email, cargo]
    );

    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresaId, novoUsuario.rows[0].id, 'criou conta', 'membros', novoUsuario.rows[0].id]
    );

    res.status(201).json({ mensagem: "Conta criada!", empresa_id: empresaId, usuario_id: novoUsuario.rows[0].id });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Erro interno no servidor." });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const resultado = await pool.query('SELECT * FROM membros WHERE email = $1', [email]);
    if (resultado.rows.length === 0) return res.status(401).json({ erro: "E-mail não encontrado." });
    
    const usuario = resultado.rows[0];
    res.json({ 
      mensagem: "Login realizado!", 
      usuario: { id: usuario.id, nome: usuario.nome, cargo: usuario.cargo, empresa_id: usuario.empresa_id } 
    });
  } catch (erro) {
    res.status(500).json({ erro: "Erro interno no servidor." });
  }
});

// ==========================================
// RECUPERAÇÃO DE SENHA
// ==========================================

app.post('/api/auth/forget-password', async (req, res) => {
  const { email } = req.body;
  try {
    const NEON_AUTH_URL = process.env.NEON_AUTH_URL; 
    const resposta = await fetch(`${NEON_AUTH_URL}/forget-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, redirectTo: 'https://tanocaixaapp.com.br/app.html' })
    });
    if (resposta.ok) res.json({ mensagem: "E-mail enviado." });
    else res.status(400).json({ erro: "Erro ao enviar." });
  } catch (erro) { res.status(500).json({ erro: "Erro de conexão." }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const NEON_AUTH_URL = process.env.NEON_AUTH_URL;
    const resposta = await fetch(`${NEON_AUTH_URL}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword })
    });
    if (resposta.ok) res.json({ mensagem: "Senha alterada." });
    else res.status(400).json({ erro: "Token inválido." });
  } catch (erro) { res.status(500).json({ erro: "Erro de conexão." }); }
});

// ==========================================
// CONFIGURAÇÕES DA EMPRESA
// ==========================================

app.get('/api/empresa', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const resultado = await pool.query('SELECT id, nome_fantasia, data_criacao, data_expiracao, permitir_ajudante_apagar FROM empresas WHERE id = $1', [empresa_id]);
    if (resultado.rows.length === 0) return res.status(404).json({ erro: "Empresa não encontrada." });
    res.json(resultado.rows[0]);
  } catch (erro) { res.status(500).json({ erro: "Erro ao buscar empresa." }); }
});

app.put('/api/empresa', async (req, res) => {
  const { empresa_id, nome_fantasia, criado_por, permitir_ajudante_apagar } = req.body;
  try {
    await pool.query('UPDATE empresas SET nome_fantasia = $1, permitir_ajudante_apagar = $2 WHERE id = $3', [nome_fantasia, permitir_ajudante_apagar, empresa_id]);
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'editou', 'empresas', empresa_id]
    );
    res.json({ mensagem: "Empresa atualizada!" });
  } catch (erro) { res.status(500).json({ erro: "Erro ao atualizar empresa." }); }
});

// ==========================================
// TRANSAÇÕES
// ==========================================

app.get('/api/transacoes', async (req, res) => {
  const { empresa_id } = req.query; 
  try {
    const resultado = await pool.query('SELECT * FROM transacoes WHERE empresa_id = $1 ORDER BY data_transacao DESC', [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) { res.status(500).json({ erro: "Erro ao buscar transações." }); }
});

app.post('/api/transacoes', async (req, res) => {
  const { empresa_id, criado_por, tipo, valor, descricao, categoria } = req.body;
  try {
    const nova = await pool.query(
      'INSERT INTO transacoes (empresa_id, criado_por, tipo, valor, descricao, categoria) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [empresa_id, criado_por, tipo, valor, descricao, categoria || 'Outros']
    );
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
      [empresa_id, criado_por, 'criou', 'transacoes', nova.rows[0].id, JSON.stringify({ tipo, valor, descricao, categoria })]
    );
    res.status(201).json(nova.rows[0]);
  } catch (erro) { res.status(500).json({ erro: "Erro ao salvar transação." }); }
});

app.delete('/api/transacoes/:id', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, criado_por } = req.body;
  try {
    const user = await pool.query('SELECT cargo FROM membros WHERE id = $1', [criado_por]);
    const config = await pool.query('SELECT permitir_ajudante_apagar FROM empresas WHERE id = $1', [empresa_id]);
    
    if (user.rows[0].cargo === 'ajudante' && !config.rows[0].permitir_ajudante_apagar) {
      return res.status(403).json({ erro: "Permissão negada. O gestor não permite que ajudantes apaguem lançamentos." });
    }

    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'apagou', 'transacoes', id]
    );
    await pool.query('DELETE FROM transacoes WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);
    res.json({ mensagem: "Transação apagada." });
  } catch (erro) { res.status(500).json({ erro: "Erro ao apagar transação." }); }
});

// ==========================================
// CONTAS A PAGAR
// ==========================================

app.get('/api/contas', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const resultado = await pool.query('SELECT * FROM contas WHERE empresa_id = $1 ORDER BY data_vencimento ASC', [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) { res.status(500).json({ erro: "Erro ao buscar contas." }); }
});

app.post('/api/contas', async (req, res) => {
  const { empresa_id, criado_por, descricao, valor, data_vencimento, categoria } = req.body;
  try {
    const dataLimpa = data_vencimento.split('T')[0]; 
    const nova = await pool.query(
      'INSERT INTO contas (empresa_id, criado_por, descricao, valor, data_vencimento, categoria) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [empresa_id, criado_por, descricao, valor, dataLimpa, categoria || 'Outros']
    );
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
      [empresa_id, criado_por, 'criou', 'contas', nova.rows[0].id, JSON.stringify({ descricao, valor, categoria })]
    );
    res.status(201).json(nova.rows[0]);
  } catch (erro) { res.status(500).json({ erro: "Erro ao salvar conta." }); }
});

app.delete('/api/contas/:id', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, criado_por } = req.body;
  try {
    const user = await pool.query('SELECT cargo FROM membros WHERE id = $1', [criado_por]);
    const config = await pool.query('SELECT permitir_ajudante_apagar FROM empresas WHERE id = $1', [empresa_id]);
    
    if (user.rows[0].cargo === 'ajudante' && !config.rows[0].permitir_ajudante_apagar) {
      return res.status(403).json({ erro: "Permissão negada." });
    }

    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'apagou/pagou', 'contas', id]
    );
    await pool.query('DELETE FROM contas WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);
    res.json({ mensagem: "Conta resolvida." });
  } catch (erro) { res.status(500).json({ erro: "Erro ao resolver conta." }); }
});

// ==========================================
// CHECKLIST FISCAL
// ==========================================

app.get('/api/fiscal', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const resultado = await pool.query('SELECT * FROM checklist_fiscal WHERE empresa_id = $1 ORDER BY data_vencimento ASC', [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) { res.status(500).json({ erro: "Erro ao buscar tarefas." }); }
});

app.post('/api/fiscal', async (req, res) => {
  const { empresa_id, criado_por, descricao, data_vencimento } = req.body;
  try {
    const dataLimpa = data_vencimento ? data_vencimento.split('T')[0] : null; 
    const nova = await pool.query(
      'INSERT INTO checklist_fiscal (empresa_id, criado_por, descricao, data_vencimento) VALUES ($1, $2, $3, $4) RETURNING *',
      [empresa_id, criado_por, descricao, dataLimpa]
    );
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
      [empresa_id, criado_por, 'criou', 'checklist_fiscal', nova.rows[0].id, JSON.stringify({ descricao })]
    );
    res.status(201).json(nova.rows[0]);
  } catch (erro) { res.status(500).json({ erro: "Erro ao salvar tarefa." }); }
});

app.put('/api/fiscal/:id', async (req, res) => {
  const { id } = req.params;
  const { concluida } = req.body;
  try {
    await pool.query('UPDATE checklist_fiscal SET concluida = $1 WHERE id = $2', [concluida, id]);
    res.json({ mensagem: "Status atualizado." });
  } catch (erro) { res.status(500).json({ erro: "Erro ao atualizar." }); }
});

app.delete('/api/fiscal/:id', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, criado_por } = req.body;
  try {
    const user = await pool.query('SELECT cargo FROM membros WHERE id = $1', [criado_por]);
    const config = await pool.query('SELECT permitir_ajudante_apagar FROM empresas WHERE id = $1', [empresa_id]);
    
    if (user.rows[0].cargo === 'ajudante' && !config.rows[0].permitir_ajudante_apagar) {
      return res.status(403).json({ erro: "Permissão negada." });
    }

    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'apagou', 'checklist_fiscal', id]
    );
    await pool.query('DELETE FROM checklist_fiscal WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);
    res.json({ mensagem: "Tarefa apagada." });
  } catch (erro) { res.status(500).json({ erro: "Erro ao apagar." }); }
});

// ==========================================
// EQUIPE E AUDITORIA
// ==========================================

app.post('/api/equipe/convidar', async (req, res) => {
  const { empresa_id, criado_por, email_convidado } = req.body;
  try {
    const jaMembro = await pool.query('SELECT * FROM membros WHERE email = $1 AND empresa_id = $2', [email_convidado, empresa_id]);
    if (jaMembro.rows.length > 0) return res.status(400).json({ erro: "Já faz parte da equipe." });

    const jaConvidado = await pool.query('SELECT * FROM convites WHERE email_convidado = $1 AND empresa_id = $2 AND status = $3', [email_convidado, empresa_id, 'pendente']);
    if (jaConvidado.rows.length > 0) return res.status(400).json({ erro: "Convite já pendente." });

    await pool.query('INSERT INTO convites (empresa_id, email_convidado, criado_por) VALUES ($1, $2, $3)', [empresa_id, email_convidado, criado_por]);
    res.status(201).json({ mensagem: "Convite gerado!" });
  } catch (erro) { res.status(500).json({ erro: "Erro ao convidar." }); }
});

app.get('/api/equipe', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const membros = await pool.query('SELECT id, nome, email, cargo FROM membros WHERE empresa_id = $1', [empresa_id]);
    const convites = await pool.query('SELECT id, email_convidado, status FROM convites WHERE empresa_id = $1 AND status = $2', [empresa_id, 'pendente']);
    res.json({ membros: membros.rows, convites: convites.rows });
  } catch (erro) { res.status(500).json({ erro: "Erro ao buscar equipe." }); }
});

app.get('/api/auditoria', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const resultado = await pool.query(`
      SELECT l.id, l.acao, l.tabela_afetada, l.detalhes, l.data_hora, m.nome as usuario_nome
      FROM logs_auditoria l
      LEFT JOIN membros m ON l.user_id = m.id
      WHERE l.empresa_id = $1 
      ORDER BY l.data_hora DESC
    `, [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) { res.status(500).json({ erro: "Erro ao buscar auditoria." }); }
});

// ==========================================
// RELATÓRIO PDF (COM CATEGORIA)
// ==========================================

app.get('/api/relatorio', async (req, res) => {
  const { empresa_id, mes } = req.query; 
  try {
    const transacoes = await pool.query(
      "SELECT * FROM transacoes WHERE empresa_id = $1 AND TO_CHAR(data_transacao, 'YYYY-MM') = $2 ORDER BY data_transacao ASC",
      [empresa_id, mes]
    );
    const empresa = await pool.query('SELECT nome_fantasia FROM empresas WHERE id = $1', [empresa_id]);
    const nomeEmpresa = empresa.rows.length > 0 ? empresa.rows[0].nome_fantasia : "Minha Empresa";

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="extrato_${mes}.pdf"`);
    doc.pipe(res);

    doc.fontSize(22).fillColor('#294b3b').text("TanoCaixaApp", { align: 'left' });
    doc.fontSize(10).fillColor('#788078').text("O seu assistente financeiro", { align: 'left' });
    doc.moveDown(2);

    doc.fontSize(16).fillColor('#35443a').text(`Extrato de Movimentações`, { align: 'left' });
    doc.fontSize(10).text(`Empresa: ${nomeEmpresa}`);
    doc.text(`Mês de referência: ${mes}`);
    doc.text(`Emitido em: ${new Date().toLocaleString('pt-BR')}`);
    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#e5e9e2');
    doc.moveDown(1.5);

    const tableTop = doc.y;
    doc.fontSize(10).fillColor('#788078');
    doc.text("Data", 50, tableTop);
    doc.text("Descrição", 110, tableTop);
    doc.text("Categoria", 320, tableTop);
    doc.text("Valor", 450, tableTop, { width: 100, align: 'right' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#e5e9e2');
    doc.moveDown(1);

    let saldo = 0;
    if (transacoes.rows.length === 0) {
      doc.fontSize(10).fillColor('#788078').text("Nenhuma movimentação registrada neste mês.", { align: 'center' });
    } else {
      transacoes.rows.forEach(t => {
        const data = new Date(t.data_transacao).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const isEntrada = t.tipo === 'entrada';
        const sinal = isEntrada ? '+' : '-';
        const cor = isEntrada ? '#426b4c' : '#946451';
        const valor = parseFloat(t.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        if (isEntrada) saldo += parseFloat(t.valor);
        else saldo -= parseFloat(t.valor);
        const y = doc.y;
        doc.fontSize(10).fillColor('#35443a').text(data, 50, y);
        doc.text(t.descricao, 110, y, { width: 200 });
        doc.text(t.categoria || 'Outros', 320, y, { width: 120 });
        doc.fillColor(cor).text(`${sinal} ${valor}`, 450, y, { width: 100, align: 'right' });
        doc.moveDown(1);
      });
    }

    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke('#e5e9e2');
    doc.moveDown(1);
    doc.fontSize(14).fillColor('#294b3b').text(`Saldo do Mês:`, 350, doc.y, { width: 100, align: 'right' });
    doc.fillColor(saldo < 0 ? '#d68c75' : '#426b4c').text(`${saldo.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, 450, doc.y, { width: 100, align: 'right' });
    doc.end();
  } catch (erro) { res.status(500).json({ erro: "Erro ao gerar PDF." }); }
});

// ==========================================
// PAGAMENTOS (ASAAS)
// ==========================================
app.post('/api/pagamento/assinar', async (req, res) => {
  const { empresa_id, nome_empresa, email_gestor, cpf_cnpj } = req.body; // Adicionamos o cpf_cnpj aqui
  console.log("👀 ESPIÃO: O CPF que chegou no servidor foi:", cpf_cnpj);
  const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
  const ASAAS_URL = 'https://api.asaas.com/v3'; 

  try {
    const empresaDb = await pool.query('SELECT gateway_customer_id, nome_fantasia FROM empresas WHERE id = $1', [empresa_id]);
    let customerId = empresaDb.rows[0].gateway_customer_id;

    if (!customerId) {
      const respCliente = await fetch(`${ASAAS_URL}/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'access_token': ASAAS_API_KEY
        },
        body: JSON.stringify({
          name: nome_empresa || empresaDb.rows[0].nome_fantasia,
          email: email_gestor,
          cpfCnpj: cpf_cnpj, // AQUI: Enviando o CPF/CNPJ para o Asaas
          externalReference: empresa_id
        })
      });
      
      const dadosCliente = await respCliente.json();
      if (dadosCliente.errors) return res.status(400).json({ erro: "Erro no Asaas", detalhes: dadosCliente.errors });
      
      customerId = dadosCliente.id;
      await pool.query('UPDATE empresas SET gateway_customer_id = $1, cpf_cnpj = $2 WHERE id = $3', [customerId, cpf_cnpj, empresa_id]); // Salva o ID do Asaas e o CPF no banco
    }

    const respAssinatura = await fetch(`${ASAAS_URL}/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY
      },
      body: JSON.stringify({
        customer: customerId,
        billingType: 'UNDEFINED', 
        value: 9.90,
        nextDueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        cycle: 'MONTHLY',
        description: 'Assinatura TanoCaixaApp',
        externalReference: empresa_id
      })
    });

    const dadosAssinatura = await respAssinatura.json();
    if (dadosAssinatura.errors) return res.status(400).json({ erro: "Erro no Asaas", detalhes: dadosAssinatura.errors });

    const respCobrancas = await fetch(`${ASAAS_URL}/payments?subscription=${dadosAssinatura.id}`, {
      headers: { 'access_token': ASAAS_API_KEY }
    });
    const dadosCobrancas = await respCobrancas.json();
    const linkPagamento = dadosCobrancas.data[0]?.invoiceUrl;

    res.json({ link_pagamento: linkPagamento });

  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Erro interno ao gerar pagamento." });
  }
});

// ==========================================
// PAGAMENTOS (ASAAS) - INÍCIO
// ==========================================

app.post('/api/pagamento/assinar', async (req, res) => {
  const { empresa_id, nome_empresa, email_gestor } = req.body;
  const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
  const ASAAS_URL = 'https://api.asaas.com/v3'; 

  try {
    const empresaDb = await pool.query('SELECT gateway_customer_id, nome_fantasia FROM empresas WHERE id = $1', [empresa_id]);
    let customerId = empresaDb.rows[0].gateway_customer_id;

    // Cria o cliente no Asaas se não existir
    if (!customerId) {
      const respCliente = await fetch(`${ASAAS_URL}/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'access_token': ASAAS_API_KEY
        },
        body: JSON.stringify({
          name: nome_empresa || empresaDb.rows[0].nome_fantasia,
          email: email_gestor,
          externalReference: empresa_id
        })
      });
      
      const dadosCliente = await respCliente.json();
      if (dadosCliente.errors) return res.status(400).json({ erro: "Erro no Asaas", detalhes: dadosCliente.errors });
      
      customerId = dadosCliente.id;
      await pool.query('UPDATE empresas SET gateway_customer_id = $1 WHERE id = $2', [customerId, empresa_id]);
    }

    // Cria a assinatura mensal de 9.90
    const respAssinatura = await fetch(`${ASAAS_URL}/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY
      },
      body: JSON.stringify({
        customer: customerId,
        billingType: 'UNDEFINED', 
        value: 9.90,
        nextDueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        cycle: 'MONTHLY',
        description: 'Assinatura TanoCaixaApp',
        externalReference: empresa_id
      })
    });

    const dadosAssinatura = await respAssinatura.json();
    if (dadosAssinatura.errors) return res.status(400).json({ erro: "Erro no Asaas", detalhes: dadosAssinatura.errors });

    // Pega o link para o cliente pagar
    const respCobrancas = await fetch(`${ASAAS_URL}/payments?subscription=${dadosAssinatura.id}`, {
      headers: { 'access_token': ASAAS_API_KEY }
    });
    const dadosCobrancas = await respCobrancas.json();
    const linkPagamento = dadosCobrancas.data[0]?.invoiceUrl;

    res.json({ link_pagamento: linkPagamento });

  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Erro interno ao gerar pagamento." });
  }
});

app.post('/api/pagamento/webhook', async (req, res) => {
  const evento = req.body;
  const ASAAS_WEBHOOK_SECRET = process.env.ASAAS_WEBHOOK_SECRET; 
  const tokenRecebido = req.headers['asaas-access-token'];

  if (ASAAS_WEBHOOK_SECRET && tokenRecebido !== ASAAS_WEBHOOK_SECRET) {
    return res.status(401).send('Não autorizado');
  }

  try {
    if (evento.event === 'PAYMENT_CONFIRMED' || evento.event === 'PAYMENT_RECEIVED') {
      const empresaId = evento.payment.externalReference;

      if (empresaId) {
        await pool.query(
          "UPDATE empresas SET status_assinatura = 'ativo', data_expiracao = NOW() + INTERVAL '30 days' WHERE id = $1", 
          [empresaId]
        );
        
        await pool.query(
          'INSERT INTO logs_auditoria (empresa_id, acao, tabela_afetada, detalhes) VALUES ($1, $2, $3, $4)',
          [empresaId, 'pagamento aprovado', 'empresas', JSON.stringify({ valor: evento.payment.value, id_pagamento: evento.payment.id })]
        );
      }
    }
    res.status(200).send('Webhook recebido com sucesso.');
  } catch (erro) {
    console.error('Erro no Webhook:', erro);
    res.status(500).send('Erro interno.');
  }
});

// ==========================================
// PAGAMENTOS (ASAAS) - FIM
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

// ==========================================
// ROTA DE VERIFICAÇÃO DE ASSINATURA
// ==========================================
app.get('/api/empresa/status', async (req, res) => {
  try {
    const empresaId = req.query.empresa_id;

    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id não enviado' });
    }

    const resultado = await pool.query(
      'SELECT status_assinatura, data_criacao FROM empresas WHERE id = $1',
      [empresaId]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }

    const empresa = resultado.rows[0];
    const criadoEm = new Date(empresa.data_criacao);
    const trialFim = new Date(criadoEm);
    trialFim.setDate(trialFim.getDate() + 30);

    res.json({
      status_assinatura: empresa.status_assinatura,
      trial_fim: trialFim.toISOString()
    });

  } catch (erro) {
    console.error('Erro ao buscar status:', erro);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

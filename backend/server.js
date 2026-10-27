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
// AUTENTICAÇÃO E EQUIPE
// ==========================================

app.post('/api/auth/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: "Preencha todos os campos." });

  try {
    const usuarioExiste = await pool.query('SELECT * FROM membros WHERE email = $1', [email]);
    if (usuarioExiste.rows.length > 0) return res.status(400).json({ erro: "Este e-mail já está cadastrado." });

    // 1. Verifica se existe um convite pendente para este e-mail
    const convite = await pool.query('SELECT * FROM convites WHERE email_convidado = $1 AND status = $2', [email, 'pendente']);
    
    let empresaId;
    
    if (convite.rows.length > 0) {
      // Se tem convite, usa a empresa do convite e marca o convite como aceito
      empresaId = convite.rows[0].empresa_id;
      await pool.query('UPDATE convites SET status = $1 WHERE id = $2', ['aceito', convite.rows[0].id]);
    } else {
      // Se não tem convite, cria uma nova empresa (ele é o Gestor)
      const novaEmpresa = await pool.query('INSERT INTO empresas (nome_fantasia) VALUES ($1) RETURNING id', [`Empresa de ${nome}`]);
      empresaId = novaEmpresa.rows[0].id;
    }

    // 2. Cria o usuário na empresa correta
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
    if (resultado.rows.length === 0) return res.status(401).json({ erro: "E-mail ou senha incorretos." });
    
    const usuario = resultado.rows[0];
    res.json({ 
      mensagem: "Login realizado!", 
      usuario: { id: usuario.id, nome: usuario.nome, cargo: usuario.cargo, empresa_id: usuario.empresa_id } 
    });
  } catch (erro) {
    res.status(500).json({ erro: "Erro interno no servidor." });
  }
});

// NOVO: CONVIDAR MEMBRO
app.post('/api/equipe/convidar', async (req, res) => {
  const { empresa_id, criado_por, email_convidado } = req.body;
  try {
    // Verifica se já é membro
    const jaMembro = await pool.query('SELECT * FROM membros WHERE email = $1 AND empresa_id = $2', [email_convidado, empresa_id]);
    if (jaMembro.rows.length > 0) return res.status(400).json({ erro: "Esta pessoa já faz parte da sua equipe." });

    // Verifica se já tem convite pendente
    const jaConvidado = await pool.query('SELECT * FROM convites WHERE email_convidado = $1 AND empresa_id = $2 AND status = $3', [email_convidado, empresa_id, 'pendente']);
    if (jaConvidado.rows.length > 0) return res.status(400).json({ erro: "Já existe um convite pendente para este e-mail." });

    await pool.query(
      'INSERT INTO convites (empresa_id, email_convidado, criado_por) VALUES ($1, $2, $3)',
      [empresa_id, email_convidado, criado_por]
    );

    res.status(201).json({ mensagem: "Convite gerado com sucesso!" });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: "Erro ao convidar." });
  }
});

// NOVO: LISTAR EQUIPE
app.get('/api/equipe', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const membros = await pool.query('SELECT id, nome, email, cargo FROM membros WHERE empresa_id = $1', [empresa_id]);
    const convites = await pool.query('SELECT id, email_convidado, status FROM convites WHERE empresa_id = $1 AND status = $2', [empresa_id, 'pendente']);
    
    res.json({ membros: membros.rows, convites: convites.rows });
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao buscar equipe." });
  }
});

// ==========================================
// TRANSAÇÕES
// ==========================================

app.get('/api/transacoes', async (req, res) => {
  const { empresa_id } = req.query; 
  try {
    const resultado = await pool.query('SELECT * FROM transacoes WHERE empresa_id = $1 ORDER BY data_transacao DESC', [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao buscar transações." });
  }
});

app.post('/api/transacoes', async (req, res) => {
  const { empresa_id, criado_por, tipo, valor, descricao } = req.body;
  try {
    const nova = await pool.query(
      'INSERT INTO transacoes (empresa_id, criado_por, tipo, valor, descricao) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [empresa_id, criado_por, tipo, valor, descricao]
    );
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
      [empresa_id, criado_por, 'criou', 'transacoes', nova.rows[0].id, JSON.stringify({ tipo, valor, descricao })]
    );
    res.status(201).json(nova.rows[0]);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao salvar transação." });
  }
});

app.delete('/api/transacoes/:id', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, criado_por } = req.body;
  try {
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'apagou', 'transacoes', id]
    );
    await pool.query('DELETE FROM transacoes WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);
    res.json({ mensagem: "Transação apagada." });
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao apagar transação." });
  }
});

// ==========================================
// CONTAS A PAGAR
// ==========================================

app.get('/api/contas', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const resultado = await pool.query('SELECT * FROM contas WHERE empresa_id = $1 ORDER BY data_vencimento ASC', [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao buscar contas." });
  }
});

app.post('/api/contas', async (req, res) => {
  const { empresa_id, criado_por, descricao, valor, data_vencimento } = req.body;
  try {
    const dataLimpa = data_vencimento.split('T')[0]; 
    const nova = await pool.query(
      'INSERT INTO contas (empresa_id, criado_por, descricao, valor, data_vencimento) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [empresa_id, criado_por, descricao, valor, dataLimpa]
    );
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
      [empresa_id, criado_por, 'criou', 'contas', nova.rows[0].id, JSON.stringify({ descricao, valor })]
    );
    res.status(201).json(nova.rows[0]);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao salvar conta." });
  }
});

app.delete('/api/contas/:id', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, criado_por } = req.body;
  try {
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'apagou/pagou', 'contas', id]
    );
    await pool.query('DELETE FROM contas WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);
    res.json({ mensagem: "Conta resolvida." });
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao resolver conta." });
  }
});

// ==========================================
// CHECKLIST FISCAL
// ==========================================

app.get('/api/fiscal', async (req, res) => {
  const { empresa_id } = req.query;
  try {
    const resultado = await pool.query('SELECT * FROM checklist_fiscal WHERE empresa_id = $1 ORDER BY data_vencimento ASC', [empresa_id]);
    res.json(resultado.rows);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao buscar tarefas fiscais." });
  }
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
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao salvar tarefa fiscal." });
  }
});

app.put('/api/fiscal/:id', async (req, res) => {
  const { id } = req.params;
  const { concluida } = req.body;
  try {
    await pool.query('UPDATE checklist_fiscal SET concluida = $1 WHERE id = $2', [concluida, id]);
    res.json({ mensagem: "Status atualizado." });
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao atualizar tarefa." });
  }
});

app.delete('/api/fiscal/:id', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, criado_por } = req.body;
  try {
    await pool.query(
      'INSERT INTO logs_auditoria (empresa_id, user_id, acao, tabela_afetada, registro_id) VALUES ($1, $2, $3, $4, $5)',
      [empresa_id, criado_por, 'apagou', 'checklist_fiscal', id]
    );
    await pool.query('DELETE FROM checklist_fiscal WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);
    res.json({ mensagem: "Tarefa apagada." });
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao apagar tarefa." });
  }
});

// ==========================================
// AUDITORIA E PDF
// ==========================================

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
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao buscar logs de auditoria." });
  }
});

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
    doc.text("Descrição", 120, tableTop);
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
        doc.text(t.descricao, 120, y, { width: 300 });
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
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao gerar PDF." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose'); // Importar mongoose para validação de ObjectId

// Importações dos modelos, garantindo que sejam carregados corretamente
const Escola = require('../models/Escola');
const Feira = require('../models/Feira');
const Projeto = require('../models/Projeto');
const Categoria = require('../models/Categoria');
const Criterio = require('../models/Criterio');
const Avaliador = require('../models/Avaliador');
const Avaliacao = require('../models/Avaliacao');
const Admin = require('../models/Admin');
const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PreCadastroAvaliador = require('../models/PreCadastroAvaliador');
const ConfiguracaoFormularioPreCadastro = require('../models/ConfiguracaoFormularioPreCadastro');

const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { sendEmail } = require('../utils/emailSender');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const chromium = require('@sparticuz/chromium');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const QRCode = require('qrcode');
const { storage } = require('../config/cloudinary');
const upload = multer({ storage });
const rotasPreCadastros = require('./preCadastro');
const Mensagem = require('../models/mensagensSuporte');
const enviarMensagemTelegram = require('../utils/telegram');
const MensagemSuporte = require('../models/mensagensSuporte');
const cloudinary = require('cloudinary').v2;


// Carrega variáveis de ambiente (garante que estão disponíveis para este arquivo)
require('dotenv').config();

// ===========================================
// VERIFICAÇÃO DE MODELOS (Adicionado para depuração)
// ===========================================
// Verifica se os modelos foram carregados corretamente.
// Se qualquer um desses for undefined ou não for um Model Mongoose,
// indica um problema de importação/carregamento.
if (!Feira || typeof Feira.findOne !== 'function' ||
    !Projeto || typeof Projeto.findOne !== 'function' ||
    !Categoria || typeof Categoria.findOne !== 'function' ||
    !Criterio || typeof Criterio.findOne !== 'function' ||
    !Avaliador || typeof Avaliador.findOne !== 'function' ||
    !Avaliacao || typeof Avaliacao.findOne !== 'function' ||
    !Admin || typeof Admin.findOne !== 'function' ||
    !Escola || typeof Escola.findOne !== 'function') {
    console.error('ERRO CRÍTICO: Um ou mais modelos Mongoose não foram carregados corretamente. Verifique os caminhos de importação e a exportação dos modelos.');
    // Isso pode causar um erro de inicialização ou impedir o servidor de subir corretamente.
    // Dependendo da criticidade, você pode querer encerrar o processo: process.exit(1);
}
function generatePin(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PIN_ALPHABET.charAt(Math.floor(Math.random() * PIN_ALPHABET.length));
  }
  return out;
}

// Gera PIN único no banco (collection Avaliador)
async function generateUniquePin(length = 6, maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pin = generatePin(length);

    // confere se já existe
    const exists = await Avaliador.exists({ pin });
    if (!exists) return pin;
  }

  throw new Error('Não foi possível gerar um PIN único. Tente novamente.');
}
function getCloudinaryPublicId(url) {
  if (!url) return null;
  const parts = url.split('/');
  const fileName = parts.pop(); // ex: relatorio.pdf
  const folderIndex = parts.indexOf('upload') + 1;
  const folder = parts.slice(folderIndex).join('/');
  const publicId = `${folder}/${fileName.replace(/\.[^/.]+$/, '')}`;
  return publicId;
}

// ===========================================
// FUNÇÕES AUXILIARES
// ===========================================

// Função para formatar data para input HTML (YYYY-MM-DD)
function formatarDataParaInput(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
// ===========================================
// FUNÇÕES AUXILIARES - AVALIAÇÕES E PONTUAÇÃO
// ===========================================

/**
 * Retorna o ID de um critério independentemente de ele
 * estar populado ou ser apenas um ObjectId.
 */
function getCriterioId(criterio) {
    if (!criterio) return null;

    if (criterio._id) {
        return String(criterio._id);
    }

    return String(criterio);
}


/**
 * Retorna um Set contendo somente os IDs dos critérios
 * configurados especificamente para o projeto.
 *
 * A fonte oficial dos critérios de um projeto é:
 *
 * projeto.criterios
 */
function getIdsCriteriosProjeto(projeto) {
    const criterios = Array.isArray(projeto?.criterios)
        ? projeto.criterios
        : [];

    return new Set(
        criterios
            .map(getCriterioId)
            .filter(Boolean)
    );
}


/**
 * Retorna somente os itens válidos de uma avaliação:
 *
 * - o critério precisa pertencer ao projeto;
 * - precisa possuir nota;
 * - a nota precisa estar entre 5 e 10.
 *
 * Isso também protege os relatórios contra avaliações antigas
 * que eventualmente tenham critérios que não pertencem mais
 * ao projeto.
 */
function getItensValidosDaAvaliacao(avaliacao, projeto) {
    const criteriosPermitidos = getIdsCriteriosProjeto(projeto);

    const itens = Array.isArray(avaliacao?.itens)
        ? avaliacao.itens
        : [];

    return itens.filter(item => {
        if (!item || !item.criterio) {
            return false;
        }

        const criterioId = String(item.criterio);

        if (!criteriosPermitidos.has(criterioId)) {
            return false;
        }

        const nota = Number(item.nota);

        return (
            item.nota !== undefined &&
            item.nota !== null &&
            item.nota !== '' &&
            !Number.isNaN(nota) &&
            nota >= 5 &&
            nota <= 10
        );
    });
}


/**
 * Verifica se UMA avaliação possui nota válida para TODOS
 * os critérios configurados no projeto.
 */
function avaliacaoEstaCompleta(avaliacao, projeto) {
    const criteriosProjeto = getIdsCriteriosProjeto(projeto);

    // Projeto sem critérios configurados
    if (criteriosProjeto.size === 0) {
        return false;
    }

    if (!avaliacao) {
        return false;
    }

    const itensValidos = getItensValidosDaAvaliacao(
        avaliacao,
        projeto
    );

    const criteriosAvaliados = new Set(
        itensValidos.map(item => String(item.criterio))
    );

    return [...criteriosProjeto].every(
        criterioId => criteriosAvaliados.has(criterioId)
    );
}


/**
 * Calcula o resultado de um projeto considerando:
 *
 * 1. somente projeto.criterios;
 * 2. somente notas válidas desses critérios;
 * 3. média de cada critério entre os avaliadores;
 * 4. peso de cada critério;
 * 5. média ponderada final.
 *
 * IMPORTANTE:
 * projeto.criterios deve estar populado para que o peso
 * dos critérios esteja disponível.
 */
function calcularResultadoProjeto(projeto, avaliacoesDoProjeto = []) {
    const criterios = Array.isArray(projeto?.criterios)
        ? projeto.criterios
        : [];

    const mediasCriterios = {};

    let totalNotaPonderada = 0;
    let totalPeso = 0;

    for (const criterio of criterios) {
        const criterioId = getCriterioId(criterio);

        if (!criterioId) {
            continue;
        }

        /*
         * Como o cálculo precisa do peso, o critério deve estar
         * populado. Se não estiver, usamos peso 1 como segurança,
         * mas nossas rotas corrigidas irão popular os critérios.
         */
        const peso = Number(criterio?.peso) || 1;

        const notas = [];

        for (const avaliacao of avaliacoesDoProjeto) {
            const itens = Array.isArray(avaliacao?.itens)
                ? avaliacao.itens
                : [];

            for (const item of itens) {
                if (
                    String(item.criterio) === criterioId &&
                    item.nota !== undefined &&
                    item.nota !== null &&
                    item.nota !== ''
                ) {
                    const nota = Number(item.nota);

                    if (
                        !Number.isNaN(nota) &&
                        nota >= 5 &&
                        nota <= 10
                    ) {
                        notas.push(nota);
                    }
                }
            }
        }

        if (notas.length === 0) {
            mediasCriterios[criterioId] = null;
            continue;
        }

        const somaNotas = notas.reduce(
            (soma, nota) => soma + nota,
            0
        );

        const mediaCriterio =
            somaNotas / notas.length;

        mediasCriterios[criterioId] =
            mediaCriterio;

        totalNotaPonderada +=
            mediaCriterio * peso;

        totalPeso += peso;
    }

    const notaFinal =
        totalPeso > 0
            ? totalNotaPonderada / totalPeso
            : null;

    return {
        mediasCriterios,
        notaFinal,
        totalPeso
    };
}


/**
 * Obtém os critérios de desempate pertencentes ao projeto.
 *
 * Ordem:
 * 1 = maior prioridade
 * 2 = segunda prioridade
 * etc.
 *
 * ordemDesempate 0 não participa.
 */
function getCriteriosDesempateProjeto(projeto) {
    const criterios = Array.isArray(projeto?.criterios)
        ? projeto.criterios
        : [];

    return criterios
        .filter(criterio =>
            criterio &&
            criterio._id &&
            Number(criterio.ordemDesempate) > 0
        )
        .sort(
            (a, b) =>
                Number(a.ordemDesempate) -
                Number(b.ordemDesempate)
        );
}


/**
 * Compara dois resultados para ranking.
 *
 * Primeiro:
 * nota final.
 *
 * Em caso de empate:
 * critérios configurados para desempate.
 */
function compararResultadosProjetos(a, b) {
    const notaA = Number(a.notaFinal);
    const notaB = Number(b.notaFinal);

    const temNotaA = Number.isFinite(notaA);
    const temNotaB = Number.isFinite(notaB);

    if (temNotaA && !temNotaB) return -1;
    if (!temNotaA && temNotaB) return 1;
    if (!temNotaA && !temNotaB) return 0;

    // Maior nota primeiro
    if (notaA !== notaB) {
        return notaB - notaA;
    }

    /*
     * Para o desempate, usamos os critérios do projeto A.
     *
     * Projetos da mesma categoria normalmente terão os mesmos
     * critérios de desempate. Mais à frente vamos reforçar isso
     * na montagem do ranking.
     */
    const criteriosDesempate =
        getCriteriosDesempateProjeto(a);

    for (const criterio of criteriosDesempate) {
        const criterioId =
            String(criterio._id);

        const mediaA =
            Number(
                a.mediasCriterios?.[
                    criterioId
                ]
            );

        const mediaB =
            Number(
                b.mediasCriterios?.[
                    criterioId
                ]
            );

        const temMediaA =
            Number.isFinite(mediaA);

        const temMediaB =
            Number.isFinite(mediaB);

        if (
            temMediaA &&
            temMediaB &&
            mediaA !== mediaB
        ) {
            return mediaB - mediaA;
        }

        if (
            temMediaA &&
            !temMediaB
        ) {
            return -1;
        }

        if (
            !temMediaA &&
            temMediaB
        ) {
            return 1;
        }
    }

    return 0;
}

// Função para enviar e-mail de redefinição de PIN para avaliador
async function sendResetPinEmail(avaliador) {
  const html = `
    <p>Olá, ${avaliador.nome},</p>
    <p>Seu PIN de acesso ao sistema AvaliaFeiras foi redefinido.</p>
    <p>Seu novo PIN é: <strong>${avaliador.pin}</strong></p>
    <p>Por favor, utilize este PIN para acessar sua conta de avaliador.</p>
    <p>Se você não solicitou esta redefinição, por favor, ignore este e-mail.</p>
    <br>
    <p>Atenciosamente,</p>
    <p>Equipe AvaliaFeiras</p>
  `;

  try {
    await sendEmail({
      to: avaliador.email,
      subject: 'Redefinição de PIN do Avaliador - AvaliaFeiras',
      html,
      from: process.env.EMAIL_FROM, // se seu emailSender já define "from", pode remover esta linha
    });

    console.log(`Email de redefinição de PIN enviado para ${avaliador.email}`);
    return true;
  } catch (error) {
    console.error(`Erro ao enviar email de redefinição de PIN para ${avaliador.email}:`, error);
    return false;
  }
}

// ===========================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ===========================================

// Middleware para verificar se o usuário é um admin autenticado e tem escolaId na sessão
function verificarAdminEscola(req, res, next) {
    // É crucial verificar res.headersSent para evitar o erro "Cannot set headers after they are sent to the client"
    if (res.headersSent) {
        console.warn('Headers já enviados, impedindo redirecionamento em verificarAdminEscola.');
        return; // Não faça nada se os headers já foram enviados
    }

    if (req.session.adminEscola && req.session.adminEscola.role === 'admin' && req.session.adminEscola.escolaId) {
        return next();
    }

    // Se o admin logou mas não tem escolaId na sessão (problema de dados ou sessão antiga)
    if (req.session.adminEscola && !req.session.adminEscola.escolaId) {
        const errorMessage = 'Seu perfil de administrador não está vinculado a uma escola válida. Faça login novamente ou entre em contato com o suporte.';
        
        req.session.destroy(err => {
            if (err) console.error('Erro ao destruir sessão por falta de escolaId:', err);
            // Certifica-se de limpar o cookie APENAS se a sessão foi destruída
            if (!res.headersSent) {
                res.clearCookie('connect.sid'); // Limpa o cookie da sessão
                req.flash('error_msg', errorMessage); // Tenta usar flash, mas pode falhar se a sessão já foi embora
                res.redirect('/admin/login');
            }
        });
        return; // Sai da função para evitar o erro "headers already sent"
    }

    // Se não está logado
    req.flash('error_msg', 'Por favor, faça login como administrador para acessar esta página.');
    res.redirect('/admin/login');
}

// ===========================================
// ROTAS DE AUTENTICAÇÃO (ADMIN)
// ===========================================

// Rota de Login (GET) - Renderiza o formulário de login
router.get('/login', (req, res) => {
    res.render('admin/login', {
        layout: 'layouts/public',
        titulo: 'Login Admin',
        error_msg: req.flash('error_msg'),
        success_msg: req.flash('success_msg'),
        error: req.flash('error')
    });
});

// Rota de Login (POST) - Processa o formulário de login
router.post('/login', async (req, res) => {
    const { usuario, senha } = req.body;

    if (!usuario || !senha) {
        req.flash('error_msg', 'Por favor, preencha todos os campos.');
        return res.render('admin/login', {
            layout: 'layouts/public',
            titulo: 'Login Admin',
            error_msg: req.flash('error_msg'),
            usuario
        });
    }

    try {
        // Popula o campo 'escolaId' para garantir que o objeto escola esteja disponível
        const admin = await Admin.findOne({ email: usuario }).populate('escolaId'); // USANDO escolaId AQUI

        if (!admin) {
            req.flash('error_msg', 'Credenciais inválidas.');
            return res.render('admin/login', {
                layout: 'layouts/public',
                titulo: 'Login Admin',
                error_msg: req.flash('error_msg'),
                usuario
            });
        }

        const isMatch = await bcrypt.compare(senha, admin.senha);

        if (!isMatch) {
            req.flash('error_msg', 'Credenciais inválidas.');
            return res.render('admin/login', {
                layout: 'layouts/public',
                titulo: 'Login Admin',
                error_msg: req.flash('error_msg'),
                usuario
            });
        }

        let escolaIdParaSessao = null;
        // Verifica se 'admin.escolaId' e 'admin.escolaId._id' são válidos
        if (admin.escolaId && admin.escolaId._id) { // USANDO escolaId AQUI
            escolaIdParaSessao = admin.escolaId._id.toString(); // Converte para string
        } else {
            // Se o admin não tem uma escola associada válida (ou a referência está quebrada)
            console.error(`Admin ${admin.email} logado mas não possui uma escola associada válida.`);
            const errorMessage = 'Seu perfil de administrador não está vinculado a uma escola válida. Por favor, entre em contato com o suporte.';
            
            // Destrói a sessão primeiro e, no callback, renderiza a página de login
            req.session.destroy(err => {
                if (err) console.error('Erro ao destruir sessão durante login por falta de escolaId:', err);
                
                // Limpa o cookie da sessão após a destruição da sessão.
                // Verifica se os headers já foram enviados antes de tentar limpar cookies/renderizar.
                if (!res.headersSent) {
                    res.clearCookie('connect.sid'); 
                    // Passa a mensagem de erro diretamente, já que req.flash pode não funcionar após session.destroy
                    res.render('admin/login', {
                        layout: 'layouts/public',
                        titulo: 'Login Admin',
                        error_msg: errorMessage,
                        usuario
                    });
                }
            });
            return; // Sai da função para evitar que o código continue e tente enviar outra resposta
        }

        req.session.adminEscola = {
            id: admin._id,
            nome: admin.nome,
            email: admin.email,
            role: admin.role || 'admin',
            escolaId: escolaIdParaSessao // Usa o ID da escola validado
        };

        req.flash('success_msg', 'Login de administrador realizado com sucesso!');
        res.redirect('/admin/dashboard');

    } catch (err) {
        console.error('Erro no login do admin:', err);
        // Verifica se os headers já foram enviados antes de tentar renderizar uma página de erro
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro no servidor. Tente novamente mais tarde. Detalhes: ' + err.message);
            res.render('admin/login', {
                layout: 'layouts/public',
                titulo: 'Login Admin',
                error_msg: req.flash('error_msg'),
                usuario
            });
        }
    }
});

// Rota de Logout (POST)
router.post('/logout', verificarAdminEscola, (req, res, next) => {
    req.flash('success_msg', 'Você saiu da sua conta de administrador.'); 
    req.session.destroy(err => {
        if (err) {
            console.error('Erro ao destruir sessão:', err);
            return next(err);
        }
        res.clearCookie('connect.sid');
        res.redirect('/admin/login');
    });
});

// ===================================
// ===================================
// ROTAS DE RECUPERAÇÃO DE SENHA
// ===================================

// Rota GET para exibir o formulário de solicitação de recuperação de senha
router.get('/recuperar-senha', (req, res) => {
  res.render('admin/recuperar-senha', {
    titulo: 'Recuperar Senha',
    layout: 'layouts/public',
    error_msg: req.flash('error_msg'),
    success_msg: req.flash('success_msg')
  });
});

// Rota POST para processar a solicitação de recuperação de senha (envia o e-mail)
router.post('/recuperar-senha', async (req, res) => {
  const { email } = req.body;

  try {
    if (!email) {
      req.flash('error_msg', 'Informe seu e-mail.');
      return res.redirect('/admin/recuperar-senha');
    }

    const admin = await Admin.findOne({ email: email.trim() });
    if (!admin) {
      req.flash('error_msg', 'E-mail não encontrado.');
      return res.redirect('/admin/recuperar-senha');
    }

    // Gera token e salva no admin
    const token = crypto.randomBytes(20).toString('hex');
    admin.resetPasswordToken = token;
    admin.resetPasswordExpires = Date.now() + 3600000; // 1 hora
    await admin.save();

    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const resetURL = `${baseUrl}/admin/resetar-senha/${token}`;

    // Envia email (usa seu utils/emailSender)
    await sendEmail({
      to: admin.email,
      subject: 'Redefinição de Senha - Sistema AvaliaFeiras',
      html: `
        <p>Olá,</p>
        <p>Você solicitou a redefinição da sua senha no Sistema AvaliaFeiras.</p>
        <p>Clique no link abaixo para redefinir sua senha:</p>
        <p><a href="${resetURL}">${resetURL}</a></p>
        <p>Este link é válido por 1 hora. Se você não solicitou esta redefinição, ignore este e-mail.</p>
        <p>Atenciosamente,<br>Equipe AvaliaFeiras</p>
      `,
      from: process.env.EMAIL_FROM,
    });

    req.flash('success_msg', 'Um link de redefinição de senha foi enviado para seu e-mail.');
    return res.redirect('/admin/recuperar-senha');

  } catch (err) {
    console.error('Erro na solicitação de recuperação de senha:', err);
    req.flash('error_msg', 'Ocorreu um erro ao processar sua solicitação. Por favor, tente novamente.');
    return res.redirect('/admin/recuperar-senha');
  }
});

// Rota GET para exibir o formulário de redefinição de senha (com token)
router.get('/resetar-senha/:token', async (req, res) => {
  try {
    const admin = await Admin.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!admin) {
      req.flash('error_msg', 'Token de redefinição de senha inválido ou expirado.');
      return res.redirect('/admin/recuperar-senha');
    }

    res.render('admin/resetar-senha', {
      titulo: 'Redefinir Senha',
      token: req.params.token,
      layout: 'layouts/public',
      error_msg: req.flash('error_msg'),
      success_msg: req.flash('success_msg')
    });

  } catch (err) {
    console.error('Erro ao carregar página de redefinição:', err);
    req.flash('error_msg', 'Ocorreu um erro ao carregar a página de redefinição. Por favor, tente novamente.');
    return res.redirect('/admin/recuperar-senha');
  }
});

// Rota POST para processar a nova senha
router.post('/resetar-senha/:token', async (req, res) => {
  const { token } = req.params;
  const { senha, confirmarSenha } = req.body;

  const errors = [];
  if (!senha || !confirmarSenha) errors.push('Preencha todos os campos.');
  if (senha !== confirmarSenha) errors.push('As senhas não coincidem.');
  if (senha && senha.length < 6) errors.push('A senha deve ter pelo menos 6 caracteres.');

  if (errors.length > 0) {
    req.flash('error_msg', errors.join(' '));
    return res.render('admin/resetar-senha', {
      titulo: 'Redefinir Senha',
      token,
      layout: 'layouts/public',
      error_msg: req.flash('error_msg'),
      success_msg: req.flash('success_msg')
    });
  }

  try {
    const admin = await Admin.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!admin) {
      req.flash('error_msg', 'Token de redefinição de senha inválido ou expirado.');
      return res.redirect('/admin/recuperar-senha');
    }

    const salt = await bcrypt.genSalt(10);
    admin.senha = await bcrypt.hash(senha, salt);

    admin.resetPasswordToken = undefined;
    admin.resetPasswordExpires = undefined;

    await admin.save();

    req.flash('success_msg', 'Sua senha foi redefinida com sucesso. Faça login com sua nova senha.');
    return res.redirect('/admin/login');

  } catch (err) {
    console.error('Erro na redefinição de senha:', err);
    req.flash('error_msg', 'Ocorreu um erro ao redefinir sua senha. Por favor, tente novamente.');
    return res.render('admin/resetar-senha', {
      titulo: 'Redefinir Senha',
      token,
      layout: 'layouts/public',
      error_msg: req.flash('error_msg'),
      success_msg: req.flash('success_msg')
    });
  }
});

// ===========================================
// ROTAS DE RELATÓRIOS (PDF) - COM PUPPETEER
// ==========================================
async function generatePdfReport(req, res, templateName, data, filename) {
    let browser = null;
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const escola = await Escola.findById(escolaId).lean();
        const feiraAtual = await Feira.findOne({ escolaId: escolaId, status: 'ativa' }).lean();

        const html = await ejs.renderFile(path.join(__dirname, `../views/admin/${templateName}.ejs`), {
            layout: false,
            escola,
            feiraAtual,
            ...data,
            formatarData: (dateString) => {
                if (!dateString) return 'N/A';
                const date = new Date(dateString);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0'); // padStart(2, '0') para garantir 2 dígitos
                return `${day}/${month}/${year}`;
            }
        });

        // Configuração Puppeteer para Render com @sparticuz/chromium
        browser = await puppeteer.launch({
            args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(), // Corrigido: `executablePath` é uma propriedade, não uma função
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: `<div style="font-size: 8px; margin-left: 1cm; margin-right: 1cm; color: #777; text-align: right;">${filename.replace(/_/g, ' ').toUpperCase()}</div>`,
            footerTemplate: `<div style="font-size: 8px; margin-left: 1cm; margin-right: 1cm; color: #777; text-align: center;">Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`,
            margin: {
                top: '2cm',
                right: '1cm',
                bottom: '2cm',
                left: '1cm'
            }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
        res.send(pdf);

    } catch (err) {
        console.error(`Erro ao gerar PDF de ${filename}:`, err);
        if (!res.headersSent) {
            req.flash('error_msg', `Erro ao gerar PDF de ${filename}. Detalhes: ` + err.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}


// ===========================================
// ROTAS DO DASHBOARD (PROTEGIDAS)
// ===========================================

// Rota principal do Dashboard Admin
router.get('/dashboard', verificarAdminEscola, async (req, res) => {
  if (res.headersSent) {
    console.warn('Headers já enviados na rota do dashboard, abortando renderização.');
    return;
  }

  try {
    const escolaId = req.session.adminEscola.escolaId;
    const feiraIdSelecionada = req.query.feiraId;
    let feiraAtual;

    if (feiraIdSelecionada && mongoose.Types.ObjectId.isValid(feiraIdSelecionada)) {
      feiraAtual = await Feira.findOne({ _id: feiraIdSelecionada, escolaId });
    } else {
      feiraAtual = await Feira.findOne({ status: 'ativa', escolaId });
    }

    const feiras = await Feira.find({ escolaId }).sort({ inicioFeira: -1 });
    const escolaDoAdmin = await Escola.findById(escolaId);
    const escolas = await Escola.find({});

    const escola = escolaDoAdmin || {
      nome: "Nome da Escola",
      endereco: "Endereço da Escola",
      telefone: "(XX) XXXX-XXXX",
      email: "email@escola.com",
      descricao: "Descrição da escola.",
      diretor: "Nome do Diretor",
      responsavel: "Nome do Responsável",
      _id: null
    };

    if (!feiraAtual) {
      return res.render('admin/dashboard', {
        titulo: 'Dashboard Admin',
        layout: false,
        usuarioLogado: req.session.adminEscola,
        activeTab: req.query.tab || 'dashboard-geral',
        feiras,
        escolas,
        feiraAtual: null,
        projetos: [],
        categorias: [],
        criterios: [],
        avaliadores: [],
        avaliacoes: [],
        projetosPorCategoria: {},
        avaliacoesPorAvaliadorCount: {},
        mediaAvaliacaoPorCriterio: {},
        statusProjetosCount: {},
        escola,
        totalProjetos: 0,
        totalAvaliadores: 0,
        projetosAvaliadosCompletosCount: 0,
        projetosPendentesAvaliacaoCount: 0,
        mediaGeralAvaliacoes: 0,
        relatorioFinalPorProjeto: {},
        formatarDatasParaInput: formatarDataParaInput,
        preCadastros: [],
        camposExtras: [],
        mensagens: []
      });
    }

        // --- INÍCIO: PREPARAÇÃO DE DADOS PARA O DASHBOARD GERAL (TODAS AS ABAS) ---
        // Todas as buscas agora incluem o filtro 'escolaId: escolaId'
        const projetosFetched = feiraAtual ? await Projeto.find({ feira: feiraAtual._id, escolaId: escolaId }).populate('categoria').populate('criterios').lean() : []; // USANDO escolaId AQUI
        const categoriasFetched = feiraAtual ? await Categoria.find({ feira: feiraAtual._id, escolaId: escolaId }).lean() : []; // USANDO escolaId AQUI
        const criteriosOficiais = feiraAtual ? await Criterio.find({ feira: feiraAtual._id, escolaId: escolaId }).lean() : []; // USANDO escolaId AQUI
        const avaliadoresFetched = feiraAtual ? await Avaliador.find({ feira: feiraAtual._id, escolaId: escolaId }).populate('projetosAtribuidos').lean() : []; // USANDO escolaId AQUI
        const avaliacoesFetched = feiraAtual ? await Avaliacao.find({ feira: feiraAtual._id, escolaId: escolaId }).lean() : []; // USANDO escolaId AQUI

        let projetosPorCategoria = {};
        if (feiraAtual && projetosFetched) {
            projetosFetched.forEach(p => {
                const categoriaNome = p.categoria ? p.categoria.nome : 'Sem Categoria';
                if (!projetosPorCategoria[categoriaNome]) {
                    projetosPorCategoria[categoriaNome] = [];
                }
                projetosPorCategoria[categoriaNome].push(p);
            });
        }

    // ============================================================
// AVALIAÇÕES POR AVALIADOR
// ============================================================
//
// Agora consideramos como "feita" somente uma avaliação
// completa para aquele projeto, respeitando projeto.criterios.
// ============================================================

let avaliacoesPorAvaliadorCount = {};

if (feiraAtual && avaliadoresFetched) {

    avaliadoresFetched.forEach(avaliador => {

        const projetosAtribuidos = Array.isArray(avaliador.projetosAtribuidos)
            ? avaliador.projetosAtribuidos
            : [];

        let totalAvaliacoesCompletas = 0;

        for (const projetoAtribuido of projetosAtribuidos) {

            const projetoId = String(
                projetoAtribuido?._id || projetoAtribuido
            );

            const projeto = projetosFetched.find(
                p => String(p._id) === projetoId
            );

            if (!projeto) {
                continue;
            }

            const avaliacao = avaliacoesFetched.find(a =>
                String(a.avaliador) === String(avaliador._id) &&
                String(a.projeto) === String(projeto._id)
            );

            if (
                avaliacao &&
                avaliacaoEstaCompleta(avaliacao, projeto)
            ) {
                totalAvaliacoesCompletas++;
            }
        }

        avaliacoesPorAvaliadorCount[avaliador.nome] =
            totalAvaliacoesCompletas;
    });
}


// ============================================================
// MÉDIA GERAL POR CRITÉRIO
// ============================================================
//
// Calcula somente notas válidas e somente quando o critério
// pertence ao projeto daquela avaliação.
//
// Isso impede avaliações antigas de contaminarem os números.
// ============================================================

let mediaAvaliacaoPorCriterio = {};

if (
    feiraAtual &&
    avaliacoesFetched.length > 0
) {

    const criteriosMap = {};

    for (const avaliacao of avaliacoesFetched) {

        const projeto = projetosFetched.find(
            p =>
                avaliacao.projeto &&
                String(p._id) === String(avaliacao.projeto)
        );

        if (!projeto) {
            continue;
        }

        const itensValidos =
            getItensValidosDaAvaliacao(
                avaliacao,
                projeto
            );

        for (const item of itensValidos) {

            const criterioId =
                String(item.criterio);

            if (!criteriosMap[criterioId]) {

                criteriosMap[criterioId] = {
                    soma: 0,
                    quantidade: 0
                };
            }

            criteriosMap[criterioId].soma +=
                Number(item.nota);

            criteriosMap[criterioId].quantidade++;
        }
    }

    for (const criterioId in criteriosMap) {

        const criterio =
            criteriosOficiais.find(
                c =>
                    String(c._id) ===
                    String(criterioId)
            );

        if (!criterio) {
            continue;
        }

        const dados =
            criteriosMap[criterioId];

        if (dados.quantidade > 0) {

            mediaAvaliacaoPorCriterio[
                criterio.nome
            ] =
                dados.soma /
                dados.quantidade;
        }
    }
}


// ============================================================
// STATUS DOS PROJETOS
// ============================================================

let statusProjetosCount = {
    'Não Avaliado': 0,
    'Em avaliação': 0,
    'Avaliado': 0
};


// ============================================================
// MÉTRICAS DO DASHBOARD
// ============================================================

let totalProjetos = 0;
let totalAvaliadores = 0;

let projetosAvaliadosCompletosCount = 0;
let projetosPendentesAvaliacaoCount = 0;

let mediaGeralAvaliacoes = 'N/A';


// ============================================================
// PROCESSAMENTO DOS PROJETOS
// ============================================================

if (feiraAtual) {

    totalProjetos =
        projetosFetched.length;

    totalAvaliadores =
        avaliadoresFetched.length;


    // --------------------------------------------------------
    // Guardaremos as notas finais dos projetos para calcular
    // a média geral da feira.
    // --------------------------------------------------------

    const notasFinaisProjetos = [];


    for (const projeto of projetosFetched) {

        // ====================================================
        // AVALIADORES ATRIBUÍDOS A ESTE PROJETO
        // ====================================================

        const avaliadoresDoProjeto =
            avaliadoresFetched.filter(avaliador => {

                if (
                    !Array.isArray(
                        avaliador.projetosAtribuidos
                    )
                ) {
                    return false;
                }

                return avaliador.projetosAtribuidos.some(
                    projetoAtribuido => {

                        const idProjetoAtribuido =
                            String(
                                projetoAtribuido?._id ||
                                projetoAtribuido
                            );

                        return (
                            idProjetoAtribuido ===
                            String(projeto._id)
                        );
                    }
                );
            });


        const numAvaliadoresAtribuidos =
            avaliadoresDoProjeto.length;


        // ====================================================
        // AVALIAÇÕES DESTE PROJETO
        // ====================================================

        const avaliacoesDoProjeto =
            avaliacoesFetched.filter(
                avaliacao =>
                    avaliacao.projeto &&
                    String(avaliacao.projeto) ===
                    String(projeto._id)
            );


        // ====================================================
        // AVALIAÇÕES COMPLETAS
        // ====================================================

        const avaliacoesCompletas =
            avaliacoesDoProjeto.filter(
                avaliacao =>
                    avaliacaoEstaCompleta(
                        avaliacao,
                        projeto
                    )
            );


        // ====================================================
        // CRITÉRIOS DO PROJETO
        // ====================================================

        const criteriosDoProjeto =
            Array.isArray(projeto.criterios)
                ? projeto.criterios
                : [];

        const totalCriteriosProjeto =
            criteriosDoProjeto.length;


        // ====================================================
        // QUANTIDADE DE CRITÉRIOS JÁ AVALIADOS
        //
        // Aqui contamos somente os critérios que realmente
        // pertencem ao projeto.
        // ====================================================

        const criteriosAvaliadosSet =
            new Set();

        for (const avaliacao of avaliacoesDoProjeto) {

            const itensValidos =
                getItensValidosDaAvaliacao(
                    avaliacao,
                    projeto
                );

            for (const item of itensValidos) {

                criteriosAvaliadosSet.add(
                    String(item.criterio)
                );
            }
        }


        // ====================================================
        // CAMPOS USADOS PELA VIEW
        // ====================================================

        projeto.avaliacoesFeitas =
            avaliacoesCompletas.length;

        projeto.totalAvaliadores =
            numAvaliadoresAtribuidos;

        projeto.criteriosAvaliadosCount =
            criteriosAvaliadosSet.size;

        projeto.totalCriterios =
            totalCriteriosProjeto;


        // ====================================================
        // STATUS DO PROJETO
        // ====================================================
        //
        // Regra:
        //
        // Não Avaliado:
        // nenhum avaliador completou a avaliação.
        //
        // Em avaliação:
        // pelo menos uma avaliação existe/iniciou, mas ainda
        // existem avaliadores atribuídos que não completaram.
        //
        // Avaliado:
        // TODOS os avaliadores atribuídos concluíram TODOS os
        // critérios daquele projeto.
        // ====================================================

        if (numAvaliadoresAtribuidos === 0) {

            projeto.statusAvaliacao =
                'Não Avaliado';

            statusProjetosCount[
                'Não Avaliado'
            ]++;

        } else if (
            avaliacoesCompletas.length === 0 &&
            avaliacoesDoProjeto.length === 0
        ) {

            projeto.statusAvaliacao =
                'Não Avaliado';

            statusProjetosCount[
                'Não Avaliado'
            ]++;

        } else if (
            avaliacoesCompletas.length <
            numAvaliadoresAtribuidos
        ) {

            projeto.statusAvaliacao =
                'Em avaliação';

            statusProjetosCount[
                'Em avaliação'
            ]++;

            projetosPendentesAvaliacaoCount++;

        } else {

            projeto.statusAvaliacao =
                'Avaliado';

            statusProjetosCount[
                'Avaliado'
            ]++;

            projetosAvaliadosCompletosCount++;
        }


        // ====================================================
        // CALCULAR NOTA FINAL
        // ====================================================
        //
        // Usa a função centralizada criada no Bloco 1.
        //
        // Ela considera:
        //
        // - somente projeto.criterios
        // - somente notas 5..10
        // - média entre avaliadores
        // - peso de cada critério
        // ====================================================

        const resultado =
            calcularResultadoProjeto(
                projeto,
                avaliacoesDoProjeto
            );


        projeto.mediasCriterios =
            resultado.mediasCriterios;


        projeto.notaFinal =
            resultado.notaFinal !== null
                ? resultado.notaFinal.toFixed(2)
                : 'N/A';


        if (
            resultado.notaFinal !== null &&
            Number.isFinite(
                resultado.notaFinal
            )
        ) {

            notasFinaisProjetos.push(
                resultado.notaFinal
            );
        }
    }


    // ========================================================
    // MÉDIA GERAL DA FEIRA
    // ========================================================
    //
    // Em vez de simplesmente misturar todas as notas individuais,
    // calculamos a média das notas finais ponderadas dos projetos.
    //
    // Isso mantém a mesma regra de peso usada no ranking.
    // ========================================================

    if (
        notasFinaisProjetos.length > 0
    ) {

        const somaNotasFinais =
            notasFinaisProjetos.reduce(
                (soma, nota) =>
                    soma + nota,
                0
            );

        mediaGeralAvaliacoes =
            (
                somaNotasFinais /
                notasFinaisProjetos.length
            ).toFixed(2);
    }
}


// ============================================================
// RELATÓRIO FINAL POR PROJETO - DASHBOARD
// ============================================================
//
// Agora usamos projeto.mediasCriterios e projeto.notaFinal,
// que foram calculados pela regra central.
// ============================================================

const relatorioFinalPorProjeto = {};

for (const projeto of projetosFetched) {

    const categoriaNome =
        projeto.categoria
            ? projeto.categoria.nome
            : 'Sem Categoria';


    if (
        !relatorioFinalPorProjeto[
            categoriaNome
        ]
    ) {

        relatorioFinalPorProjeto[
            categoriaNome
        ] = [];
    }


    // --------------------------------------------------------
    // Preparar médias apenas dos critérios do projeto
    // --------------------------------------------------------

    const mediasCriteriosProjeto = {};

    if (
        Array.isArray(projeto.criterios)
    ) {

        for (
            const criterio
            of projeto.criterios
        ) {

            const criterioId =
                String(criterio._id);

            const media =
                projeto.mediasCriterios?.[
                    criterioId
                ];


            mediasCriteriosProjeto[
                criterioId
            ] =
                media !== undefined &&
                media !== null &&
                Number.isFinite(
                    Number(media)
                )
                    ? Number(media).toFixed(2)
                    : 'N/A';
        }
    }


    relatorioFinalPorProjeto[
        categoriaNome
    ].push({

        _id:
            projeto._id,

        titulo:
            projeto.titulo,

        categoria:
            projeto.categoria,

        criterios:
            projeto.criterios,

        numAvaliacoes:
            projeto.avaliacoesFeitas,

        totalAvaliadores:
            projeto.totalAvaliadores,

        statusAvaliacao:
            projeto.statusAvaliacao,

        mediasCriterios:
            mediasCriteriosProjeto,

        notaFinal:
            projeto.notaFinal,

        mediaGeral:
            projeto.notaFinal
    });
}


// ============================================================
// ORDENAR RESULTADOS POR CATEGORIA
// ============================================================
//
// 1º nota final
// 2º critérios de desempate
//
// Cada projeto mantém somente seus critérios.
// ============================================================

for (
    const categoria
    in relatorioFinalPorProjeto
) {

    relatorioFinalPorProjeto[
        categoria
    ].sort(
        compararResultadosProjetos
    );
}
        // --- FIM: PREPARAÇÃO DE DADOS PARA O DASHBOARD GERAL ---

        const activeTab = req.query.tab || 'dashboard-geral';
        const preCadastros = await PreCadastroAvaliador.find({
  feiraId: feiraAtual._id,
  status: 'pendente'
}).lean();

const mensagens = await Mensagem.find({ autorId: req.session.adminEscola.id })
  .sort({ dataEnvio: -1 })
  .lean();

        // Renderiza o dashboard principal e passa TODOS os dados necessários para as abas
        res.render('admin/dashboard', {
  titulo: 'Dashboard Admin',
  layout: false,
  usuarioLogado: req.session.adminEscola,
  activeTab: activeTab,
  feiras,
  escolas,
  feiraAtual: feiraAtual ? feiraAtual.toObject() : null,
  projetos: projetosFetched,
  categorias: categoriasFetched,
  criterios: criteriosOficiais,
  avaliadores: avaliadoresFetched,
  avaliacoes: avaliacoesFetched,
  projetosPorCategoria,
  avaliacoesPorAvaliadorCount,
  mediaAvaliacaoPorCriterio,
  statusProjetosCount,
  escola,
  totalProjetos,
  totalAvaliadores,
  projetosAvaliadosCompletosCount,
  projetosPendentesAvaliacaoCount,
  mediaGeralAvaliacoes,
  relatorioFinalPorProjeto,
  formatarDatasParaInput: formatarDataParaInput,
  preCadastros,
  camposExtras: [],
  mensagens
});


    } catch (error) {
        console.error('Erro ao carregar dashboard do admin:', error);
        // Verifica se os headers já foram enviados antes de tentar renderizar uma página de erro
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao carregar o dashboard. Detalhes: ' + error.message); // Melhorar mensagem de erro
            res.redirect('/admin/login');
        }
    }
});

// ===========================================
// ROTAS CRUD - PROJETOS
// ===========================================

// Criar Projeto (POST)
router.post('/projetos', verificarAdminEscola, upload.single('relatorioPdf'), async (req, res) => {
  try {
    const { titulo, descricao, turma, alunos, categoria, criterios, orientador, coorientador } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    const feira = await Feira.findOne({ status: 'ativa', escolaId: adminEscolaId });
    if (!feira) {
      req.flash('error_msg', 'Nenhuma feira ativa encontrada para esta escola.');
      return res.redirect('/admin/dashboard?tab=projetos');
    }

    const relatorioUrl = req.file ? req.file.path : null;

    const novoProjeto = new Projeto({
      titulo,
      descricao,
      turma,
      alunos: typeof alunos === 'string' ? alunos.split('\n').map(a => a.trim()).filter(Boolean) : [],
      criterios: Array.isArray(criterios) ? criterios : (criterios ? [criterios] : []),
      categoria,
      escolaId: adminEscolaId,
      feira: feira._id,
      orientador,
      coorientador,
      relatorioPdf: relatorioUrl
    });

    await novoProjeto.save();
    req.flash('success_msg', 'Projeto criado com sucesso!');
  } catch (err) {
    console.error('Erro ao criar projeto:', err);
    req.flash('error_msg', 'Erro ao criar projeto: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=projetos');
});

// Editar Projeto (PUT)
router.post('/projetos/:id/editar', verificarAdminEscola, upload.single('relatorioPdf'), async (req, res) => {
  const { id } = req.params;
  const { titulo, descricao, categoria, turma, alunos, criterios, orientador, coorientador } = req.body;
  const adminEscolaId = req.session.adminEscola.escolaId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    req.flash('error_msg', 'ID do projeto inválido para edição.');
    return res.redirect('/admin/dashboard?tab=projetos');
  }

  try {
    const updateData = {
      titulo,
      descricao,
      categoria,
      turma,
      orientador,
      coorientador,
      alunos: typeof alunos === 'string'
        ? alunos.split('\n').map(a => a.trim()).filter(Boolean)
        : Array.isArray(alunos) ? alunos : [],
      criterios: Array.isArray(criterios)
        ? criterios.filter(Boolean)
        : (criterios ? [criterios].filter(Boolean) : [])
    };

    if (req.file) {
      updateData.relatorioPdf = req.file.secure_url || req.file.path || req.file.url;
    }

    const updatedProjeto = await Projeto.findOneAndUpdate(
      { _id: id, escolaId: adminEscolaId },
      updateData,
      { new: true }
    );

    if (!updatedProjeto) {
      req.flash('error_msg', 'Projeto não encontrado ou você não tem permissão para editá-lo.');
      return res.redirect('/admin/dashboard?tab=projetos');
    }

    req.flash('success_msg', 'Projeto atualizado com sucesso!');
  } catch (err) {
    console.error('Erro ao atualizar projeto:', err);
    req.flash('error_msg', 'Erro ao atualizar projeto. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=projetos');
});

// Excluir Projeto (DELETE)
router.delete('/projetos/:id', verificarAdminEscola, async (req, res) => {
  const { id } = req.params;
  const adminEscolaId = req.session.adminEscola.escolaId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    req.flash('error_msg', 'ID do projeto inválido para exclusão.');
    return res.redirect('/admin/dashboard?tab=projetos');
  }

  try {
    const projetoParaExcluir = await Projeto.findOne({ _id: id, escolaId: adminEscolaId });
    if (!projetoParaExcluir) {
      req.flash('error_msg', 'Projeto não encontrado ou você não tem permissão para excluí-lo.');
      return res.redirect('/admin/dashboard?tab=projetos');
    }

    // Remover relatório PDF do Cloudinary, se existir
    if (projetoParaExcluir.relatorioPdf) {
      const publicId = getCloudinaryPublicId(projetoParaExcluir.relatorioPdf);
      if (publicId) {
        await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
      }
    }

    await Avaliacao.deleteMany({ projeto: id, escolaId: adminEscolaId });
    await Projeto.deleteOne({ _id: id, escolaId: adminEscolaId });

    req.flash('success_msg', 'Projeto e suas avaliações excluídos com sucesso!');
  } catch (err) {
    console.error('Erro ao excluir projeto:', err);
    req.flash('error_msg', 'Erro ao excluir projeto. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=projetos');
});

// ===========================================
// ROTAS CRUD - AVALIADORES
// ===========================================

// Adicionar Avaliador (POST)

// Aprovar pré-cadastro de avaliador
router.post('/avaliadores', verificarAdminEscola, async (req, res) => {
  const { nome, email, projetosAtribuidos } = req.body;
  const escolaId = req.session.adminEscola.escolaId;

  try {
    const feira = await Feira.findOne({ status: 'ativa', escolaId });
    if (!feira) {
      req.flash('error_msg', 'Nenhuma feira ativa encontrada para a escola.');
      return res.redirect('/admin/dashboard?tab=avaliadores');
    }

    const emailExistente = await Avaliador.findOne({ email, escolaId, feira: feira._id });
    if (emailExistente) {
      req.flash('error_msg', 'Já existe um avaliador com este e-mail cadastrado para sua escola.');
      return res.redirect('/admin/dashboard?tab=avaliadores');
    }

    const pin = await generateUniquePin(6);

    const projetos = Array.isArray(projetosAtribuidos)
      ? projetosAtribuidos.filter(Boolean)
      : projetosAtribuidos
        ? [projetosAtribuidos]
        : [];

    const novoAvaliador = new Avaliador({
      nome,
      email,
      pin,
      escolaId,
      feira: feira._id,
      projetosAtribuidos: projetos
    });

    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const url = `${baseUrl}/avaliador/acesso-direto/${pin}`;
    const qrCodeBase64 = await QRCode.toDataURL(url);
    novoAvaliador.qrcode = qrCodeBase64;

    await novoAvaliador.save();

    const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_SENDER_ADDRESS;

    await sendEmail({
      to: email,
      subject: 'Bem-vindo ao AvaliaFeiras',
      from: fromAddress,
      html: `
        <p>Olá ${nome},</p>
        <p>Você foi cadastrado como avaliador no sistema AvaliaFeiras.</p>
        <p><strong>PIN de acesso:</strong> ${pin}</p>
        <p><strong>Link direto:</strong> <a href="${url}">${url}</a></p>
        <p>Acesse o sistema e utilize seu PIN ou escaneie o QR Code abaixo para avaliar os projetos atribuídos.</p>
        <p style="text-align: center;">
          <img src="${qrCodeBase64}" alt="QR Code de acesso" style="height: 200px; width: 200px;"/>
        </p>
      `
    });

    req.flash('success_msg', 'Avaliador cadastrado e e-mail enviado com sucesso.');
  } catch (err) {
    console.error('Erro ao cadastrar avaliador:', err);
    req.flash('error_msg', 'Erro ao cadastrar avaliador. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=avaliadores');
});

router.put('/avaliadores/:id', verificarAdminEscola, async (req, res) => {
  const { id } = req.params;
  const ativo = req.body.ativo === 'on';
  const { nome, email, projetosAtribuidos } = req.body;
  const escolaId = req.session.adminEscola.escolaId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    req.flash('error_msg', 'ID do avaliador inválido para edição.');
    return res.redirect('/admin/dashboard?tab=avaliadores');
  }

  try {
    const projetos = Array.isArray(projetosAtribuidos)
      ? projetosAtribuidos.filter(Boolean)
      : projetosAtribuidos
        ? [projetosAtribuidos]
        : [];

    const avaliadorAtualizado = await Avaliador.findOneAndUpdate(
      { _id: id, escolaId },
      {
        nome,
        email,
        projetosAtribuidos: projetos,
        ativo
      },
      { new: true }
    );

    if (!avaliadorAtualizado) {
      req.flash('error_msg', 'Avaliador não encontrado ou não pertence à sua escola.');
    } else {
      req.flash('success_msg', 'Avaliador atualizado com sucesso.');
    }
  } catch (err) {
    console.error('Erro ao atualizar avaliador:', err);
    req.flash('error_msg', 'Erro ao atualizar avaliador. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=avaliadores');
});

router.post('/avaliadores/reset-pin/:id', verificarAdminEscola, async (req, res) => {
  const { id } = req.params;
  const adminEscolaId = req.session.adminEscola.escolaId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    req.flash('error_msg', 'ID do avaliador inválido para redefinição de PIN.');
    return res.redirect('/admin/dashboard?tab=avaliadores');
  }

  try {
    const avaliador = await Avaliador.findOne({ _id: id, escolaId: adminEscolaId });
    if (!avaliador) {
      req.flash('error_msg', 'Avaliador não encontrado ou não pertence a esta escola.');
      return res.redirect('/admin/dashboard?tab=avaliadores');
    }

    const newPin = await generateUniquePin(6);
    avaliador.pin = newPin;
    avaliador.ativo = true;

    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const url = `${baseUrl}/avaliador/acesso-direto/${newPin}`;
    const qrcode = await QRCode.toDataURL(url);
    avaliador.qrcode = qrcode;

    await avaliador.save();

    const emailSent = await sendResetPinEmail(avaliador);

    if (emailSent) {
      req.flash('success_msg', `PIN do avaliador ${avaliador.nome} redefinido e enviado por e-mail com sucesso.`);
    } else {
      req.flash('error_msg', `PIN do avaliador ${avaliador.nome} redefinido, mas falha ao enviar e-mail.`);
    }

    res.redirect('/admin/dashboard?tab=avaliadores');
  } catch (err) {
    console.error('Erro ao redefinir PIN do avaliador:', err);
    req.flash('error_msg', 'Erro ao redefinir PIN do avaliador. Detalhes: ' + err.message);
    res.redirect('/admin/dashboard?tab=avaliadores');
  }
});

router.post('/avaliadores/:id/excluir', verificarAdminEscola, async (req, res) => {
  const { id } = req.params;
  const escolaId = req.session.adminEscola.escolaId;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    req.flash('error_msg', 'ID do avaliador inválido para exclusão.');
    return res.redirect('/admin/dashboard?tab=avaliadores');
  }

  try {
    const resultado = await Avaliador.deleteOne({ _id: id, escolaId });
    if (resultado.deletedCount === 0) {
      req.flash('error_msg', 'Avaliador não encontrado ou não pertence à sua escola.');
    } else {
      req.flash('success_msg', 'Avaliador excluído com sucesso.');
    }
  } catch (err) {
    console.error('Erro ao excluir avaliador:', err);
    req.flash('error_msg', 'Erro ao excluir avaliador. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=avaliadores');
});

router.get('/formulario-pre-cadastro/configurar', verificarAdminEscola, async (req, res) => {
  const escolaId = req.session.adminEscola.escolaId;
  let configuracao = await ConfiguracaoFormularioPreCadastro.findOne({ escolaId });

  if (!configuracao) configuracao = { camposExtras: [] };

  const camposExtrasFiltrados = configuracao.camposExtras.filter(campo => {
    const label = campo.label?.trim().toLowerCase();
    return label !== 'nome' && label !== 'email';
  });

  res.render('admin/partials/configurar-formulario-pre-cadastro', {
    layout: false,
    camposExtras: camposExtrasFiltrados,
    success_msg: req.flash('success_msg')
  });
});

router.post('/formulario-pre-cadastro/configurar', verificarAdminEscola, async (req, res) => {
  const escolaId = req.session.adminEscola.escolaId;
  let camposExtras = req.body.camposExtras || [];

  if (!Array.isArray(camposExtras)) {
    camposExtras = Object.values(camposExtras);
  }

  const camposFormatados = camposExtras
    .map(campo => ({
      label: campo.label?.trim() || '',
      tipo: campo.tipo || 'texto',
      obrigatorio: campo.obrigatorio === 'true' || campo.obrigatorio === true || campo.obrigatorio === 'on',
      opcoes: campo.opcoes?.trim() || ''
    }))
    .filter(campo => {
      const label = campo.label.toLowerCase();
      return label !== 'nome' && label !== 'email';
    });

  await ConfiguracaoFormularioPreCadastro.findOneAndUpdate(
    { escolaId },
    { camposExtras: camposFormatados },
    { upsert: true, new: true }
  );

  req.flash('success_msg', 'Configuração salva com sucesso!');
  res.redirect('/admin/dashboard?tab=avaliadores');
});

router.get('/pre-cadastros', verificarAdminEscola, async (req, res) => {
  try {
    const escolaId = req.session.adminEscola.escolaId;

    const feiras = await Feira.find({ escolaId });
    const feiraIds = feiras.map(f => f._id);

    const preCadastros = await PreCadastroAvaliador.find({ feiraId: { $in: feiraIds } });

    res.render('admin/pre-cadastros/lista', {
      layout: false,
      titulo: 'Pré-Cadastros de Avaliadores',
      preCadastros
    });
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Erro ao carregar pré-cadastros.');
    res.redirect('/admin/dashboard');
  }
});

router.get('/pre-cadastros/:id', verificarAdminEscola, async (req, res) => {
  try {
    const escolaId = req.session.adminEscola.escolaId;

    const pre = await PreCadastroAvaliador.findById(req.params.id).lean();
    if (!pre) {
      req.flash('error_msg', 'Pré-cadastro não encontrado.');
      return res.redirect('/admin/pre-cadastros');
    }

    const feira = await Feira.findOne({ _id: pre.feiraId, escolaId }).lean();
    if (!feira) {
      req.flash('error_msg', 'Feira não encontrada ou não pertence à sua escola.');
      return res.redirect('/admin/pre-cadastros');
    }

    const projetos = await Projeto.find({
      feira: feira._id,
      escolaId
    }).lean();

    res.render('admin/pre-cadastros/editar', {
      layout: false,
      titulo: 'Aprovar Pré-Cadastro',
      pre,
      projetos,
      feira
    });
  } catch (err) {
    console.error('Erro ao carregar pré-cadastro:', err);
    req.flash('error_msg', 'Erro ao carregar pré-cadastro.');
    res.redirect('/admin/pre-cadastros');
  }
});

router.post('/pre-cadastros/:id/aprovar', verificarAdminEscola, async (req, res) => {
  try {
    console.log('BODY RECEBIDO:', req.body);

    const { id } = req.params;
    const { nome, email, telefone } = req.body;
    const escolaId = req.session.adminEscola.escolaId;

    const pre = await PreCadastroAvaliador.findOne({ _id: id });
    if (!pre) {
      req.flash('error_msg', 'Pré-cadastro não encontrado.');
      return res.redirect('/admin/pre-cadastros');
    }

    const feira = await Feira.findOne({ _id: pre.feiraId, escolaId });
    if (!feira) {
      req.flash('error_msg', 'Feira não encontrada ou não pertence à sua escola.');
      return res.redirect('/admin/pre-cadastros');
    }

    const jaExiste = await Avaliador.findOne({ email, escolaId });
    if (jaExiste) {
      req.flash('error_msg', 'Já existe um avaliador com esse e-mail.');
      return res.redirect('/admin/pre-cadastros');
    }

    const pin = await generateUniquePin(6);
    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const url = `${baseUrl}/avaliador/acesso-direto/${pin}`;
    const qrcode = await QRCode.toDataURL(url);

    const novo = new Avaliador({
      nome: nome.trim(),
      email: email.trim(),
      telefone: telefone?.trim() || '',
      escolaId,
      feira: feira._id,
      pin,
      projetosAtribuidos: [],
      qrcode,
      ativo: true,
      criadoVia: 'pre-cadastro',
      extras: pre.extras || {}
    });

    await novo.save();
    await PreCadastroAvaliador.findByIdAndDelete(pre._id);

    req.flash('success_msg', 'Avaliador aprovado com sucesso.');
    res.redirect('/admin/dashboard?tab=avaliadores');
  } catch (err) {
    console.error('Erro ao aprovar pré-cadastro:', err);
    req.flash('error_msg', 'Erro ao aprovar pré-cadastro. Detalhes: ' + err.message);
    res.redirect('/admin/pre-cadastros');
  }
});

router.post('/avaliadores/:id/reenviar-email', verificarAdminEscola, async (req, res) => {
  const { id } = req.params;
  const { mensagemPersonalizada } = req.body;
  const escolaId = req.session.adminEscola.escolaId;

  try {
    const avaliador = await Avaliador.findOne({ _id: id, escolaId });
    if (!avaliador) {
      req.flash('error_msg', 'Avaliador não encontrado.');
      return res.redirect('/admin/dashboard?tab=avaliadores');
    }

    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const url = `${baseUrl}/avaliador/acesso-direto/${avaliador.pin}`;
    const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_SENDER_ADDRESS;

    await sendEmail({
      to: avaliador.email,
      subject: 'Acesso ao AvaliaFeiras',
      from: fromAddress,
      html: `
        <p>Olá ${avaliador.nome},</p>
        <p>${mensagemPersonalizada || 'Aqui estão seus dados de acesso ao AvaliaFeiras:'}</p>
        <p><strong>PIN:</strong> ${avaliador.pin}</p>
        <p><a href="${url}">${url}</a></p>
        <p>Atenciosamente,</p>
        <p>Equipe AvaliaFeiras</p>
      `
    });

    req.flash('success_msg', `E-mail reenviado para ${avaliador.nome} com sucesso.`);
  } catch (err) {
    console.error('Erro ao reenviar e-mail:', err);
    req.flash('error_msg', 'Erro ao reenviar e-mail. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=avaliadores');
});

router.post('/avaliadores/reenviar-multiplos', verificarAdminEscola, async (req, res) => {
  const { idsSelecionados, mensagemPersonalizada } = req.body;
  const escolaId = req.session.adminEscola.escolaId;

  if (!idsSelecionados) {
    req.flash('error_msg', 'Nenhum avaliador selecionado.');
    return res.redirect('/admin/dashboard?tab=avaliadores');
  }

  try {
    const idsArray = idsSelecionados.split(',').map(id => id.trim());

    const avaliadores = await Avaliador.find({ _id: { $in: idsArray }, escolaId });

    if (avaliadores.length === 0) {
      req.flash('error_msg', 'Nenhum avaliador encontrado para os IDs selecionados.');
      return res.redirect('/admin/dashboard?tab=avaliadores');
    }

    const baseUrl = process.env.APP_URL || 'http://localhost:3000';
    const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_SENDER_ADDRESS;

    for (const avaliador of avaliadores) {
      const url = `${baseUrl}/avaliador/acesso-direto/${avaliador.pin}`;

      await sendEmail({
        to: avaliador.email,
        subject: 'Acesso ao AvaliaFeiras',
        from: fromAddress,
        html: `
          <p>Olá ${avaliador.nome},</p>
          <p>${mensagemPersonalizada || 'Aqui estão seus dados de acesso ao AvaliaFeiras:'}</p>
          <p><strong>PIN:</strong> ${avaliador.pin}</p>
          <p><a href="${url}">${url}</a></p>
          <p>Atenciosamente,</p>
          <p>Equipe AvaliaFeiras</p>
        `
      });
    }

    req.flash('success_msg', `${avaliadores.length} e-mail(s) reenviado(s) com sucesso.`);
  } catch (err) {
    console.error('Erro ao reenviar e-mails múltiplos:', err);
    req.flash('error_msg', 'Erro ao reenviar e-mails. Detalhes: ' + err.message);
  }

  res.redirect('/admin/dashboard?tab=avaliadores');
});


// ===========================================
// ROTAS CRUD - FEIRAS
// ===========================================

// Criar nova feira sem excluir dados antigos
router.post('/feiras', verificarAdminEscola, async (req, res) => {
  const { nome, inicioFeira, fimFeira, status = 'ativa' } = req.body;
  const escolaId = req.session.adminEscola.escolaId;

  try {
    // Validação básica de datas
    const inicio = new Date(inicioFeira);
    const fim = new Date(fimFeira);

    if (isNaN(inicio) || isNaN(fim)) {
      req.flash('error_msg', 'Datas inválidas. Verifique os campos de início e fim da feira.');
      return res.redirect('/admin/dashboard?tab=feiras');
    }

    // Arquivar outras feiras da mesma escola antes de criar nova
    if (status === 'ativa') {
      await Feira.updateMany({ escolaId, status: 'ativa' }, { $set: { status: 'arquivada' } });
    }

    // Criar nova feira
    const novaFeira = new Feira({
      nome: nome.trim(),
      inicioFeira: inicio,
      fimFeira: fim,
      status,
      escolaId
    });

    await novaFeira.save();

    req.flash('success_msg', 'Nova feira criada com sucesso!');
    res.redirect('/admin/dashboard?tab=feiras');
  } catch (err) {
    console.error('Erro ao criar nova feira:', err);
    req.flash('error_msg', 'Erro ao criar nova feira. Detalhes: ' + err.message);
    res.redirect('/admin/dashboard?tab=feiras');
  }
});

// Editar Feira (PUT)
router.post('/feiras/editar', verificarAdminEscola, async (req, res) => {
  const { feiraId, nome, inicioFeira, fimFeira, status } = req.body;
  const escolaId = req.session.adminEscola.escolaId;

  try {
    await Feira.updateOne(
      { _id: feiraId, escolaId },
      {
        nome,
        inicioFeira: new Date(inicioFeira),
        fimFeira: new Date(fimFeira),
        status
      }
    );
    req.flash('success_msg', 'Feira atualizada com sucesso!');
    res.redirect('/admin/dashboard?tab=feiras');
  } catch (err) {
    console.error('Erro ao editar feira:', err);
    req.flash('error_msg', 'Erro ao editar feira. Tente novamente.');
    res.redirect('/admin/dashboard?tab=feiras');
  }
});

// Excluir Feira (POST)
router.post('/feiras/excluir', verificarAdminEscola, async (req, res) => {
  const { feiraId } = req.body;
  const escolaId = req.session.adminEscola.escolaId;
  try {
    await Feira.deleteOne({ _id: feiraId, escolaId });
    req.flash('success_msg', 'Feira excluída com sucesso.');
    res.redirect('/admin/dashboard?tab=feiras');
  } catch (err) {
    console.error('Erro ao excluir feira:', err);
    req.flash('error_msg', 'Erro ao excluir feira.');
    res.redirect('/admin/dashboard?tab=feiras');
  }
});

// Mudar Status da Feira (POST - usando POST para simplicidade, idealmente PUT)
router.post('/feiras/status/:id', verificarAdminEscola, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // Assume que o status (ativa/arquivada) vem do formulário
    const adminEscolaId = req.session.adminEscola.escolaId;

    // Validação de ID antes de tentar a operação no banco
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error_msg', 'ID da feira inválido para mudança de status.');
        return res.redirect('/admin/dashboard?tab=feiras');
    }

    try {
        // Encontra a feira e garante que ela pertence à escola do admin
        const feira = await Feira.findOne({ _id: id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        if (!feira) {
            req.flash('error_msg', 'Feira não encontrada ou não pertence a esta escola.');
            return res.redirect('/admin/dashboard?tab=feiras');
        }

        // Se o status for 'ativa', desativa outras feiras ativas da mesma escola
        if (status === 'ativa') {
            // Garante que o ID usado no $ne é um ObjectId válido
            await Feira.updateMany(
                { _id: { $ne: new mongoose.Types.ObjectId(id) }, status: 'ativa', escolaId: adminEscolaId }, // USANDO escolaId AQUI
                { status: 'arquivada' }
            );
        } else if (status === 'arquivada') {
            // Se estiver arquivando, garante que não há mais nenhuma feira ativa automaticamente
            // (Embora o updateMany acima já cuide de "outras ativas")
        }


        feira.status = status;
        // Se a feira está sendo arquivada, registra a data de arquivamento
        if (status === 'arquivada' && !feira.arquivadaEm) {
            feira.arquivadaEm = Date.now();
        } else if (status === 'ativa' && feira.arquivadaEm) {
            // Se está sendo reativada, remove a data de arquivamento
            feira.arquivadaEm = undefined;
        }

        await feira.save();

        req.flash('success_msg', `Status da feira "${feira.nome}" alterado para "${status}" com sucesso!`);
        res.redirect('/admin/dashboard?tab=feiras');
    } catch (err) {
        console.error('Erro ao mudar status da feira:', err);
        req.flash('error_msg', 'Erro ao mudar status da feira. Detalhes: ' + err.message);
        res.redirect('/admin/dashboard?tab=feiras');
    }
});


// Rota para Iniciar Nova Feira (POST) - Arquiva a atual e limpa dados
router.post('/configuracoes/nova', verificarAdminEscola, async (req, res) => {
    const adminEscolaId = req.session.adminEscola.escolaId;

    try {
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId: adminEscolaId }); // USANDO escolaId AQUI

        if (feiraAtual) {
            // 1. Arquiva a feira atual
            feiraAtual.status = 'arquivada';
            feiraAtual.arquivadaEm = Date.now();
            await feiraAtual.save();

            // 2. Apaga projetos, avaliadores, categorias, critérios e avaliações associados à feira arquivada
            // Filtrando por feira E escola para garantir isolamento
            //await Projeto.deleteMany({ feira: feiraAtual._id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
            //await Avaliador.deleteMany({ feira: feiraAtual._id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
            //await Avaliacao.deleteMany({ feira: feiraAtual._id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
            //await Categoria.deleteMany({ feira: feiraAtual._id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
            //  await Criterio.deleteMany({ feira: feiraAtual._id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        }
        
        // 3. Cria uma nova feira (com nome padrão e status 'ativa')
        const novaFeira = new Feira({
            nome: `Feira de Ciências ${new Date().getFullYear()}`, // Nome padrão
            status: 'ativa',
            escolaId: adminEscolaId // Vincula à escola do admin logado (USANDO escolaId AQUI)
        });
        await novaFeira.save();

        req.flash('success_msg', 'Nova feira iniciada com sucesso! A feira anterior foi arquivada.');
        res.redirect('/admin/dashboard?tab=feiras'); // Redireciona para a aba de feiras
    } catch (err) {
        console.error('Erro ao iniciar nova feira:', err);
        req.flash('error_msg', 'Erro ao iniciar nova feira. Detalhes: ' + err.message);
        res.redirect('/admin/dashboard?tab=configuracoes');
    }
});


// Excluir Feira (DELETE)
router.delete('/feiras/:id', verificarAdminEscola, async (req, res) => {
    const { id } = req.params;
    const adminEscolaId = req.session.adminEscola.escolaId;

    // Validação de ID antes de tentar a operação no banco
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error_msg', 'ID da feira inválido para exclusão.');
        return res.redirect('/admin/dashboard?tab=feiras');
    }

    try {
        // Encontra a feira e garante que ela pertence à escola do admin antes de excluir
        const feiraParaExcluir = await Feira.findOne({ _id: id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        if (!feiraParaExcluir) {
            req.flash('error_msg', 'Feira não encontrada ou você não tem permissão para excluí-la.');
            return res.redirect('/admin/dashboard?tab=feiras');
        }

        
        await Feira.deleteOne({ _id: id, escolaId: adminEscolaId }); // Finalmente, exclui a feira (USANDO escolaId AQUI)

        req.flash('success_msg', 'Feira e todos os dados associados excluídos com sucesso!');
    } catch (err) {
        console.error('Erro ao excluir feira:', err);
        req.flash('error_msg', 'Erro ao excluir feira. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=feiras');
});



// ===========================================
// ROTAS CRUD - CATEGORIAS
// ===========================================

// Adicionar Categoria (POST)
router.post('/categorias', verificarAdminEscola, async (req, res) => {
    const { nome } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    try {
        const feira = await Feira.findOne({ status: 'ativa', escolaId: adminEscolaId }); // USANDO escolaId AQUI

        if (!feira) {
            req.flash('error_msg', 'Nenhuma feira ativa encontrada para esta escola. Não é possível criar uma categoria.');
            return res.redirect('/admin/dashboard?tab=categorias');
        }

        const novaCategoria = new Categoria({
            nome,
            escolaId: adminEscolaId, // USANDO escolaId AQUI
            feira: feira._id
        });

        await novaCategoria.save();
        req.flash('success_msg', 'Categoria criada com sucesso!');
    } catch (err) {
        console.error('Erro ao criar categoria:', err);
        req.flash('error_msg', 'Erro ao criar categoria. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=categorias');
});


// Editar Categoria (PUT)
router.put('/categorias/:id', verificarAdminEscola, async (req, res) => {
    const { id } = req.params;
    const { nome } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    // Validação de ID antes de tentar a operação no banco
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error_msg', 'ID da categoria inválido para edição.');
        return res.redirect('/admin/dashboard?tab=categorias');
    }

    try {
        // Garante que a categoria a ser atualizada pertence à escola do admin
        const updatedCategoria = await Categoria.findOneAndUpdate(
            { _id: id, escolaId: adminEscolaId }, // USANDO escolaId AQUI
            { nome }, 
            { new: true }
        );

        if (!updatedCategoria) {
            req.flash('error_msg', 'Categoria não encontrada ou você não tem permissão para editá-la.');
            return res.redirect('/admin/dashboard?tab=categorias');
        }

        req.flash('success_msg', 'Categoria atualizada com sucesso!');
    }
    catch (err) {
        console.error('Erro ao atualizar categoria:', err);
        req.flash('error_msg', 'Erro ao atualizar categoria. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=categorias');
});

// Excluir Categoria (DELETE)
router.delete('/categorias/:id/excluir', verificarAdminEscola, async (req, res) => {
    const adminEscolaId = req.session.adminEscola.escolaId;

    // Validação de ID antes de tentar a operação no banco
    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
        req.flash('error_msg', 'ID da categoria inválido para exclusão.');
        return res.redirect('/admin/dashboard?tab=categorias');
    }

    try {
        // Encontra a categoria e garante que pertence à escola do admin antes de excluir
        const categoriaParaExcluir = await Categoria.findOne({ _id: req.params.id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        if (!categoriaParaExcluir) {
            req.flash('error_msg', 'Categoria não encontrada ou você não tem permissão para excluí-la.');
            return res.redirect('/admin/dashboard?tab=categorias');
        }

        await Categoria.deleteOne({ _id: req.params.id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        req.flash('success_msg', 'Categoria excluída com sucesso!');
    } catch (err) {
        console.error('Erro ao excluir categoria:', err);
        req.flash('error_msg', 'Erro ao excluir categoria. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=categorias');
});


// ===========================================
// ROTAS CRUD - CRITÉRIOS
// ===========================================

// Adicionar Critério (POST)
router.post('/criterios', verificarAdminEscola, async (req, res) => {
    const { nome, peso, observacao, ordemDesempate } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    try {
        const feira = await Feira.findOne({ status: 'ativa', escolaId: adminEscolaId });

        if (!feira) {
            req.flash('error_msg', 'Nenhuma feira ativa encontrada para esta escola. Não é possível criar um critério.');
            return res.redirect('/admin/dashboard?tab=criterios');
        }

        const novo = new Criterio({
            nome,
            peso,
            observacao,
            ordemDesempate: parseInt(ordemDesempate || 0, 10),
            escolaId: adminEscolaId,
            feira: feira._id
        });

        await novo.save();
        req.flash('success_msg', 'Critério criado com sucesso!');
    } catch (err) {
        console.error('Erro ao criar critério:', err);
        req.flash('error_msg', 'Erro ao criar critério. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=criterios');
});


// Editar Critério (PUT)
router.put('/criterios/:id', verificarAdminEscola, async (req, res) => {
    const { nome, peso, observacao, ordemDesempate } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
        req.flash('error_msg', 'ID do critério inválido para edição.');
        return res.redirect('/admin/dashboard?tab=criterios');
    }

    try {
        const updatedCriterio = await Criterio.findOneAndUpdate(
            { _id: req.params.id, escolaId: adminEscolaId },
            {
                nome,
                peso,
                observacao,
                ordemDesempate: parseInt(ordemDesempate || 0, 10)
            }
        );

        if (!updatedCriterio) {
            req.flash('error_msg', 'Critério não encontrado ou você não tem permissão para editá-lo.');
            return res.redirect('/admin/dashboard?tab=criterios');
        }

        req.flash('success_msg', 'Critério atualizado com sucesso!');
    } catch (err) {
        console.error('Erro ao editar critério:', err);
        req.flash('error_msg', 'Erro ao editar critério. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=criterios');
});


// Excluir Critério (DELETE)
router.delete('/criterios/:id/excluir', verificarAdminEscola, async (req, res) => {
    const adminEscolaId = req.session.adminEscola.escolaId;

    // Validação de ID antes de tentar a operação no banco
    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
        req.flash('error_msg', 'ID do critério inválido para exclusão.');
        return res.redirect('/admin/dashboard?tab=criterios');
    }

    try {
        // Encontra o critério e garante que pertence à escola do admin antes de excluir
        const criterioParaExcluir = await Criterio.findOne({ _id: req.params.id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        if (!criterioParaExcluir) {
            req.flash('error_msg', 'Critério não encontrado ou você não tem permissão para excluí-lo.');
            return res.redirect('/admin/dashboard?tab=criterios');
        }

        await Criterio.deleteOne({ _id: req.params.id, escolaId: adminEscolaId }); // USANDO escolaId AQUI
        req.flash('success_msg', 'Critério excluído com sucesso!');
    } catch (err) {
        console.error('Erro ao excluir critério:', err);
        req.flash('error_msg', 'Erro ao excluir critério. Detalhes: ' + err.message);
    }

    res.redirect('/admin/dashboard?tab=criterios');
});


// ===========================================
// ROTAS DE RELATÓRIOS (PDF)
// ===========================================

// Rota para Resultados Finais
router.get('/resultados-finais/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId: escolaId });
        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa para esta escola para gerar o relatório de resultados finais.');
            if (!res.headersSent) { return res.redirect('/admin/dashboard?tab=relatorios'); }
        }

        const projetos = await Projeto.find({ feira: feiraAtual._id, escolaId: escolaId })
            .populate('categoria')
            .populate('criterios')
            .lean();
        const avaliacoes = await Avaliacao.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();

        for (const projeto of projetos) {
            let totalNotaPonderada = 0;
            let totalPeso = 0;
            let criteriosAvaliadosCount = new Set();
            if (projeto.criterios && Array.isArray(projeto.criterios)) {
                for (const criterioProjeto of projeto.criterios) {
                    const avaliacoesDoCriterio = avaliacoes.flatMap(avaliacao => {
                        const notasArray = avaliacao.notas || avaliacao.itens;
                        return (notasArray && Array.isArray(notasArray)) ? notasArray.filter(nota =>
                            String(nota.criterio) === String(criterioProjeto._id) &&
                            avaliacao.projeto && String(avaliacao.projeto) === String(projeto._id) &&
                            nota.nota !== undefined && nota.nota !== null
                        ) : [];
                    });

                    if (avaliacoesDoCriterio.length > 0) {
                        const sumNotasCriterio = avaliacoesDoCriterio.reduce((acc, curr) => acc + parseFloat(curr.nota), 0);
                        const mediaCriterio = sumNotasCriterio / avaliacoesDoCriterio.length;
                        totalNotaPonderada += mediaCriterio * criterioProjeto.peso;
                        totalPeso += criterioProjeto.peso;
                        criteriosAvaliadosCount.add(String(criterioProjeto._id));
                    }
                }
            }
            projeto.notaFinal = totalPeso > 0 ? parseFloat(totalNotaPonderada / totalPeso).toFixed(2) : 'N/A';
            projeto.criteriosAvaliadosCount = criteriosAvaliadosCount.size;
            projeto.totalCriterios = projeto.criterios ? projeto.criterios.length : 0;
        }

        const projetosOrdenados = projetos.sort((a, b) => {
            const notaA = parseFloat(a.notaFinal);
            const notaB = parseFloat(b.notaFinal);
            if (isNaN(notaA) && isNaN(notaB)) return 0;
            if (isNaN(notaA)) return 1;
            if (isNaN(notaB)) return -1;
            return notaB - notaA;
        });

        const escola = await Escola.findById(escolaId).lean() || { nome: "Nome da Escola", diretor: "Diretor da Escola" };

        await generatePdfReport(req, res, 'pdf-resultados', {
            titulo: 'Resultados Finais',
            nomeFeira: feiraAtual.nome,
            projetos: projetosOrdenados,
            escola: escola
        }, `resultados-finais_${feiraAtual.nome}`);

    } catch (error) {
        console.error('Erro ao gerar PDF de resultados finais:', error);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar PDF de resultados finais. Detalhes: ' + error.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});


// Rota para PDF de Avaliações Completas
router.get('/avaliacoes/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId: escolaId });
        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa para esta escola para gerar o relatório de avaliações.');
            if (!res.headersSent) return res.redirect('/admin/dashboard?tab=relatorios');
        }

        const avaliacoes = await Avaliacao.find({ feira: feiraAtual._id, escolaId: escolaId })
            .populate('avaliador')
            .populate({ path: 'projeto', populate: { path: 'categoria' } })
            .lean();

        // Puxar critérios ordenados por ordemDesempate
        const criteriosOrdenados = await Criterio.find({ feira: feiraAtual._id, escolaId: escolaId })
            .sort({ ordemDesempate: 1, nome: 1 })
            .lean();

        const criteriosMap = {};
        criteriosOrdenados.forEach(c => {
            criteriosMap[c._id.toString()] = {
                nome: c.nome,
                ordemDesempate: c.ordemDesempate || 999
            };
        });

        const avaliacoesParaRelatorio = avaliacoes.map(avaliacao => {
            const notasArray = avaliacao.notas || avaliacao.itens;
            const notasComNomesDeCriterio = (notasArray || [])
                .map(item => {
                    const cInfo = criteriosMap[String(item.criterio)] || { nome: 'Critério Desconhecido', ordemDesempate: 999 };
                    return {
                        criterioNome: cInfo.nome,
                        valor: parseFloat(item.nota),
                        observacao: item.comentario || '',
                        ordemDesempate: cInfo.ordemDesempate
                    };
                })
                .sort((a, b) => a.ordemDesempate - b.ordemDesempate || a.criterioNome.localeCompare(b.criterioNome));

            return {
                ...avaliacao,
                avaliador: avaliacao.avaliador || { nome: 'Avaliador Removido', email: '-' },
                notasComNomesDeCriterio
            };
        });

        const escola = await Escola.findById(escolaId).lean() || { nome: "Nome da Escola" };

        await generatePdfReport(req, res, 'pdf-avaliacoes', {
            titulo: 'Avaliações Completas',
            nomeFeira: feiraAtual.nome,
            avaliacoes: avaliacoesParaRelatorio,
            escola: escola
        }, `avaliacoes_${feiraAtual.nome}`);

    } catch (error) {
        console.error('Erro ao gerar PDF de avaliações:', error);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar PDF de avaliações. Detalhes: ' + error.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});


// Rota para PDF de Projetos Sem Avaliação
router.get('/projetos-sem-avaliacao/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId: escolaId });
        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa para esta escola para gerar o relatório de projetos sem avaliação.');
            if (!res.headersSent) { return res.redirect('/admin/dashboard?tab=relatorios'); }
        }

        const projetos = await Projeto.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();
        const avaliacoes = await Avaliacao.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();
        const avaliadores = await Avaliador.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();

        const projetosSemAvaliacao = [];
        for (const projeto of projetos) {
            const numAvaliadoresAtribuidos = avaliadores.filter(av => av.projetosAtribuidos && av.projetosAtribuidos.some(pa => String(pa) === String(projeto._id))).length;
            const avaliacoesDoProjeto = avaliacoes.filter(a => a.projeto && String(a.projeto) === String(projeto._id));
            if (avaliacoesDoProjeto.length === 0 || avaliacoesDoProjeto.length < numAvaliadoresAtribuidos) {
                const assignedEvaluators = avaliadores
                    .filter(av => av.projetosAtribuidos && av.projetosAtribuidos.some(pa => String(pa) === String(projeto._id)))
                    .map(av => av.nome)
                    .join(', ');
                projetosSemAvaliacao.push({
                    titulo: projeto.titulo,
                    turma: projeto.turma,
                    totalAvaliadores: numAvaliadoresAtribuidos,
                    avaliacoesRecebidas: avaliacoesDoProjeto.length,
                    avaliadoresDesignados: assignedEvaluators || 'Nenhum avaliador atribuído'
                });
            }
        }

        const escola = await Escola.findById(escolaId).lean() || { nome: "Nome da Escola" };

        await generatePdfReport(req, res, 'pdf-projetos-sem-avaliacao', {
            titulo: 'Projetos Sem Avaliação',
            nomeFeira: feiraAtual.nome,
            projetosNaoAvaliados: projetosSemAvaliacao,
            escola: escola
        }, `projetos-sem-avaliacao_${feiraAtual.nome}`);

    } catch (error) {
        console.error('Erro ao gerar PDF de projetos sem avaliação:', error);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar PDF de projetos sem avaliação. Detalhes: ' + error.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});

// Rota para PDF de Ranking por Categoria
router.get('/ranking-categorias/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId: escolaId });
        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa para esta escola para gerar o ranking por categoria.');
            if (!res.headersSent) { 
                return res.redirect('/admin/dashboard?tab=relatorios'); 
            }
        }

        const projetos = await Projeto.find({ feira: feiraAtual._id, escolaId: escolaId })
            .populate('categoria')
            .populate('criterios')
            .lean();

        const avaliacoes = await Avaliacao.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();

        // 🔑 Ordenar categorias pela ordem definida pelo admin
        const categorias = await Categoria.find({ feira: feiraAtual._id, escolaId: escolaId })
            .sort({ ordem: 1 })
            .lean();

        const rankingPorCategoria = {};
        for (const projeto of projetos) {
            let totalNotaPonderada = 0;
            let totalPeso = 0;
            const avaliacoesDoProjeto = avaliacoes.filter(a => a.projeto && String(a.projeto) === String(projeto._id));
            const numAvaliacoes = avaliacoesDoProjeto.length;

            if (projeto.criterios && Array.isArray(projeto.criterios)) {
                for (const criterioProjeto of projeto.criterios) {
                    const avaliacoesDoCriterio = avaliacoesDoProjeto.flatMap(avaliacao => {
                        const notasArray = avaliacao.notas || avaliacao.itens;
                        return (notasArray && Array.isArray(notasArray))
                            ? notasArray.filter(item =>
                                String(item.criterio) === String(criterioProjeto._id) &&
                                item.nota !== undefined &&
                                item.nota !== null
                              )
                            : [];
                    });

                    if (avaliacoesDoCriterio.length > 0) {
                        const sumNotasCriterio = avaliacoesDoCriterio.reduce((acc, curr) => acc + parseFloat(curr.nota), 0);
                        const mediaCriterio = sumNotasCriterio / avaliacoesDoCriterio.length;
                        totalNotaPonderada += mediaCriterio * criterioProjeto.peso;
                        totalPeso += criterioProjeto.peso;
                    }
                }
            }

            projeto.notaFinal = totalPeso > 0
                ? parseFloat(totalNotaPonderada / totalPeso).toFixed(2)
                : 'N/A';
            projeto.numAvaliacoes = numAvaliacoes;
        }

        // Montar ranking respeitando a ordem dos projetos dentro de cada categoria
        categorias.forEach(cat => {
            rankingPorCategoria[cat.nome] = projetos
                .filter(p => p.categoria && String(p.categoria._id) === String(cat._id))
                .sort((a, b) => {
                    const notaA = parseFloat(a.notaFinal);
                    const notaB = parseFloat(b.notaFinal);
                    if (isNaN(notaA) && isNaN(notaB)) return 0;
                    if (isNaN(notaA)) return 1;
                    if (isNaN(notaB)) return -1;
                    return notaB - notaA; // ordem decrescente por nota
                });
        });

        const escola = await Escola.findById(escolaId).lean() || { nome: "Nome da Escola" };

        await generatePdfReport(
            req,
            res,
            'pdf-ranking-categorias',
            {
                titulo: 'Ranking por Categoria',
                nomeFeira: feiraAtual.nome,
                categorias, // 🔑 passar array já ordenado para o EJS
                rankingPorCategoria,
                escola
            },
            `ranking-categorias_${feiraAtual.nome}`
        );

    } catch (error) {
        console.error('Erro ao gerar PDF de ranking por categoria:', error);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar PDF de ranking por categoria. Detalhes: ' + error.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});


// Rota para PDF de Resumo de Avaliadores
router.get('/resumo-avaliadores/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId: escolaId });
        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa para esta escola para gerar o relatório de resumo de avaliadores.');
            if (!res.headersSent) { return res.redirect('/admin/dashboard?tab=relatorios'); }
        }

        const avaliadores = await Avaliador.find({ feira: feiraAtual._id, escolaId: escolaId }).populate('projetosAtribuidos').lean();
        const avaliacoes = await Avaliacao.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();
        const criterios = await Criterio.find({ feira: feiraAtual._id, escolaId: escolaId }).lean();

        const resumoAvaliadores = await Promise.all(avaliadores.map(async av => {
            const avaliacoesDoAvaliador = avaliacoes.filter(a => String(a.avaliador) === String(av._id));
            
            let totalAtribuidos = av.projetosAtribuidos ? av.projetosAtribuidos.length : 0;
            let totalAvaliados = 0;
            let projetosAvaliadosDetalhes = [];

            if (av.projetosAtribuidos && Array.isArray(av.projetosAtribuidos)) {
                for (const projetoAtribuido of av.projetosAtribuidos) {
                    const avaliacaoDoProjeto = avaliacoesDoAvaliador.find(a => String(a.projeto) === String(projetoAtribuido._id));
                    let statusProjeto = 'Pendente';
                    if (avaliacaoDoProjeto && (avaliacaoDoProjeto.finalizadaPorAvaliador || (avaliacaoDoProjeto.notas || avaliacaoDoProjeto.itens).length > 0)) {
                        totalAvaliados++;
                        statusProjeto = '✅ Avaliado';
                    }
                    const projetoObj = await Projeto.findById(projetoAtribuido._id).lean();
                    if (projetoObj) {
                        projetosAvaliadosDetalhes.push({ titulo: projetoObj.titulo, status: statusProjeto });
                    }
                }
            }
            return {
                nome: av.nome,
                email: av.email,
                pinAtivo: av.pin, 
                ativo: av.ativo,
                totalAtribuidos: totalAtribuidos,
                totalAvaliados: totalAvaliados,
                projetos: projetosAvaliadosDetalhes 
            };
        }));

        const escola = await Escola.findById(escolaId).lean() || { nome: "Nome da Escola" };

        await generatePdfReport(req, res, 'pdf-resumo-avaliadores', {
            titulo: 'Resumo de Avaliadores',
            nomeFeira: feiraAtual.nome,
            avaliadores: resumoAvaliadores,
            escola: escola
        }, `resumo-avaliadores_${feiraAtual.nome}`);

    } catch (error) {
        console.error('Erro ao gerar PDF de resumo de avaliadores:', error);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar PDF de resumo de avaliadores. Detalhes: ' + error.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});

// Relatório Resumo avaliadores por projetos

router.get('/resumo-projetos/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;

        // Feira ativa
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId });
        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa para esta escola para gerar o relatório de resumo de projetos.');
            if (!res.headersSent) {
                return res.redirect('/admin/dashboard?tab=relatorios');
            }
        }

        // Buscar todos os projetos da feira
        const projetos = await Projeto.find({ feira: feiraAtual._id, escolaId }).lean();
        // Buscar todos os avaliadores dessa feira
        const avaliadores = await Avaliador.find({ feira: feiraAtual._id, escolaId }).lean();
        // Buscar avaliações
        const avaliacoes = await Avaliacao.find({ feira: feiraAtual._id, escolaId }).lean();

        const resumoProjetos = await Promise.all(projetos.map(async projeto => {
            // Filtrar avaliadores que têm esse projeto atribuído
            const avaliadoresDoProjeto = avaliadores.filter(av =>
                av.projetosAtribuidos?.some(pId => String(pId) === String(projeto._id))
            );

            const avaliadoresDetalhes = avaliadoresDoProjeto.map(av => {
                // Encontrar a avaliação feita por este avaliador neste projeto
                const avaliacao = avaliacoes.find(a =>
                    String(a.projeto) === String(projeto._id) &&
                    String(a.avaliador) === String(av._id)
                );

                let status = 'Pendente';
                if (avaliacao && (avaliacao.finalizadaPorAvaliador || (avaliacao.notas || avaliacao.itens).length > 0)) {
                    status = '✅ Avaliado';
                }

                return {
                    nome: av.nome,
                    email: av.email,
                    status
                };
            });

            return {
                titulo: projeto.titulo,
                avaliadores: avaliadoresDetalhes
            };
        }));

        const escola = await Escola.findById(escolaId).lean() || { nome: "Nome da Escola" };

        await generatePdfReport(req, res, 'pdf-resumo-projetos', {
            titulo: 'Resumo de Projetos',
            nomeFeira: feiraAtual.nome,
            projetos: resumoProjetos,
            escola: escola
        }, `resumo-projetos_${feiraAtual.nome}`);

    } catch (error) {
        console.error('Erro ao gerar PDF de resumo de projetos:', error);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar PDF de resumo de projetos. Detalhes: ' + error.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});


// ROTA: Relatório Consolidado da Feira
router.get('/relatorio-consolidado/pdf', verificarAdminEscola, async (req, res) => {
    try {
        const escolaId = req.session.adminEscola.escolaId;
        const feiraAtual = await Feira.findOne({ status: 'ativa', escolaId });

        if (!feiraAtual) {
            req.flash('error_msg', 'Nenhuma feira ativa encontrada.');
            return res.redirect('/admin/dashboard?tab=relatorios');
        }

        const [projetos, avaliacoes, categorias, criteriosOficiais] = await Promise.all([
            Projeto.find({ feira: feiraAtual._id, escolaId }).populate('categoria').lean(),
            Avaliacao.find({ feira: feiraAtual._id, escolaId }).lean(),
            Categoria.find({ feira: feiraAtual._id, escolaId }).lean(),
            Criterio.find({ feira: feiraAtual._id, escolaId }).sort({ ordemDesempate: 1, nome: 1 }).lean()
        ]);

        const relatorioFinalPorProjeto = {};

        for (const projeto of projetos) {
            const avaliacoesDoProjeto = avaliacoes.filter(a => String(a.projeto) === String(projeto._id));
            const numAvaliacoes = avaliacoesDoProjeto.length;
            const mediasCriterios = {};
            let totalPeso = 0;
            let totalNotaPonderada = 0;

            for (const criterio of criteriosOficiais) {
                const notasCriterio = avaliacoesDoProjeto.flatMap(avaliacao =>
                    (avaliacao.itens || []).filter(item =>
                        String(item.criterio) === String(criterio._id) &&
                        item.nota !== undefined && item.nota !== null
                    )
                );

                if (notasCriterio.length > 0) {
                    const soma = notasCriterio.reduce((acc, cur) => acc + parseFloat(cur.nota), 0);
                    const media = soma / notasCriterio.length;
                    mediasCriterios[criterio._id.toString()] = media.toFixed(2);

                    totalNotaPonderada += media * criterio.peso;
                    totalPeso += criterio.peso;
                } else {
                    mediasCriterios[criterio._id.toString()] = '-';
                }
            }

            const mediaGeral = totalPeso > 0 ? (totalNotaPonderada / totalPeso).toFixed(2) : '-';

            const categoriaNome = projeto.categoria?.nome || 'Sem Categoria';
            if (!relatorioFinalPorProjeto[categoriaNome]) {
                relatorioFinalPorProjeto[categoriaNome] = [];
            }

            relatorioFinalPorProjeto[categoriaNome].push({
                ...projeto,
                numAvaliacoes,
                mediaGeral,
                mediasCriterios
            });
        }

        // Classificar por categoria com desempate usando ordem dos critérios
        Object.keys(relatorioFinalPorProjeto).forEach(categoria => {
            relatorioFinalPorProjeto[categoria].sort((a, b) => {
                const notaA = parseFloat(a.mediaGeral);
                const notaB = parseFloat(b.mediaGeral);

                if (!isNaN(notaA) && !isNaN(notaB)) {
                    if (notaB !== notaA) return notaB - notaA;
                } else if (!isNaN(notaA)) return -1;
                else if (!isNaN(notaB)) return 1;

                // Desempate por critérios definidos
                for (const criterio of criteriosOficiais) {
                    const nA = parseFloat(a.mediasCriterios[criterio._id.toString()]);
                    const nB = parseFloat(b.mediasCriterios[criterio._id.toString()]);
                    if (!isNaN(nA) && !isNaN(nB) && nB !== nA) return nB - nA;
                    else if (!isNaN(nA)) return -1;
                    else if (!isNaN(nB)) return 1;
                }

                return 0; 
            });
        });

        const escola = await Escola.findById(escolaId).lean();

        await generatePdfReport(req, res, 'pdf-consolidado', {
            titulo: 'Relatório Consolidado de Avaliações',
            nomeFeira: feiraAtual.nome,
            criteriosOficiais,
            relatorioFinalPorProjeto,
            escola: escola || { nome: "Nome da Escola" }
        }, `relatorio_consolidado_${feiraAtual.nome}`);

    } catch (err) {
        console.error('Erro ao gerar relatório consolidado:', err);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar relatório consolidado. ' + err.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});


// ===============================================
// ROTA PARA RELATÓRIO DE AVALIAÇÃO OFFLINE
// ===============================================
router.get('/relatorio/avaliacao-offline/:feiraId/:avaliadorId', verificarAdminEscola, async (req, res) => {
    const { feiraId, avaliadorId } = req.params;
    const adminEscolaId = req.session.adminEscola.escolaId;

    try {
        if (!feiraId || !mongoose.Types.ObjectId.isValid(feiraId)) {
            req.flash('error_msg', 'ID da feira inválido para o relatório.');
            return res.redirect('/admin/dashboard?tab=relatorios');
        }
        if (!avaliadorId || !mongoose.Types.ObjectId.isValid(avaliadorId)) {
            req.flash('error_msg', 'ID do avaliador inválido para o relatório.');
            return res.redirect('/admin/dashboard?tab=relatorios');
        }

        const feira = await Feira.findOne({ _id: feiraId, escolaId: adminEscolaId }).lean();
        if (!feira) {
            req.flash('error_msg', 'Feira não encontrada ou você não tem permissão para acessá-la.');
            return res.redirect('/admin/dashboard?tab=relatorios');
        }
        

        const avaliador = await Avaliador.findOne({ _id: avaliadorId, escolaId: adminEscolaId }).lean();
        if (!avaliador) {
            req.flash('error_msg', 'Avaliador não encontrado ou não pertence a esta escola.');
            return res.redirect('/admin/dashboard?tab=relatorios');
            
        }

        let projetosQuery = { 
            feira: feira._id, 
            escolaId: adminEscolaId,
            _id: { $in: avaliador.projetosAtribuidos || [] }
        };

        console.log('Query para buscar projetos:', JSON.stringify(projetosQuery, null, 2));
        
        const projetos = await Projeto.find(projetosQuery)
                                      .populate('categoria')
                                      .populate('escolaId') 
                                      .lean();

        const categoriaIds = [...new Set(projetos.map(p => p.categoria && p.categoria._id).filter(Boolean))];
        const criteriosPorCategoria = {};
        if (categoriaIds.length > 0) {
            const criterios = await Criterio.find({ 
                escolaId: adminEscolaId, 
                categoriaId: { $in: categoriaIds } 
            }).lean();

            criterios.forEach(criterio => {
                const catId = criterio.categoriaId.toString();
                if (!criteriosPorCategoria[catId]) {
                    criteriosPorCategoria[catId] = [];
                }
                criteriosPorCategoria[catId].push(criterio);
            });
        }

        // ✅ Definindo a função formatarData aqui
        const formatarData = (dateString) => {
            if (!dateString) return 'N/A';
            const date = new Date(dateString);
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = date.getFullYear();
            return `${day}/${month}/${year}`;
        };

        const criterios = await Criterio.find({ escolaId: adminEscolaId }).lean();

        const dataForReport = {
    titulo: `Relatório de Avaliação - ${feira.nome}`,
    feira: feira,
    projetos: projetos.map(p => {
        const criteriosIds = p.criterios || [];
        const criteriosDoProjeto = criteriosIds.length > 0
            ? criterios.filter(c => criteriosIds.some(id => String(id) === String(c._id)))
            : [];

        return {
            ...p,
            criteriosAvaliacao: criteriosDoProjeto,
            escolaNome: p.escolaId ? p.escolaId.nome : 'N/A',
            alunos: p.alunos && p.alunos.length > 0 
                ? p.alunos.map(aluno => typeof aluno === 'object' && aluno !== null && aluno.nome ? aluno.nome : aluno).join(', ') 
                : 'N/A',
            resumo: p.descricao || 'N/A',
            numero: p.numero || 'N/A',
            area: p.area || 'N/A'
        };
    }),
    avaliador: avaliador,
    formatarData
};

        const filename = `relatorio_avaliacao_offline_${feira.nome.replace(/\s/g, '_')}_${avaliador.nome.replace(/\s/g, '_').substring(0, 20)}`;
        await generatePdfReport(req, res, 'relatorio_offline', dataForReport, filename);

    } catch (err) {
        console.error('Erro ao gerar relatório de avaliação (avaliador específico):', err);
        if (!res.headersSent) {
            req.flash('error_msg', 'Erro ao gerar o relatório. Detalhes: ' + err.message);
            res.redirect('/admin/dashboard?tab=relatorios');
        }
    }
});

// Gera PDF de Avaliadores com dados extras
router.get('/pdf-avaliadores/:feiraId', verificarAdminEscola, async (req, res) => {
  const { feiraId } = req.params;
  const adminEscolaId = req.session.adminEscola.escolaId;

  try {
    if (!feiraId || !mongoose.Types.ObjectId.isValid(feiraId)) {
      req.flash('error_msg', 'ID da feira inválido para o relatório.');
      return res.redirect('/admin/dashboard?tab=relatorios');
    }

    const feira = await Feira.findOne({ _id: feiraId, escolaId: adminEscolaId }).lean();
    if (!feira) {
      req.flash('error_msg', 'Feira não encontrada.');
      return res.redirect('/admin/dashboard?tab=relatorios');
    }

    const avaliadores = await Avaliador.find({ escolaId: adminEscolaId, feira: feira._id }).lean();
    if (!avaliadores || avaliadores.length === 0) {
      req.flash('error_msg', 'Nenhum avaliador encontrado.');
      return res.redirect('/admin/dashboard?tab=relatorios');
    }

    res.render('admin/pdf-avaliadores', {
      layout: false,
      titulo: `Relatório de Avaliadores - ${feira.nome}`,
      feira,
      avaliadores
    });

  } catch (err) {
    console.error('Erro ao gerar visualização do relatório de avaliadores:', err);
    req.flash('error_msg', 'Erro ao gerar visualização do relatório.');
    res.redirect('/admin/dashboard?tab=relatorios');
  }
});

// ✅ Rota para gerar o PDF de avaliadores usando generatePdfReport padronizado
router.get('/relatorio/avaliadores/pdf/:feiraId', verificarAdminEscola, async (req, res) => {
  const { feiraId } = req.params;
  const adminEscolaId = req.session.adminEscola.escolaId;

  try {
    if (!feiraId || !mongoose.Types.ObjectId.isValid(feiraId)) {
      req.flash('error_msg', 'ID da feira inválido para o relatório.');
      return res.redirect('/admin/dashboard?tab=relatorios');
    }

    const feira = await Feira.findOne({ _id: feiraId, escolaId: adminEscolaId }).lean();
    if (!feira) {
      req.flash('error_msg', 'Feira não encontrada.');
      return res.redirect('/admin/dashboard?tab=relatorios');
    }

    const avaliadores = await Avaliador.find({ escolaId: adminEscolaId, feira: feira._id }).lean();
    if (!avaliadores || avaliadores.length === 0) {
      req.flash('error_msg', 'Nenhum avaliador encontrado.');
      return res.redirect('/admin/dashboard?tab=relatorios');
    }

    const formatarData = (dateString) => {
      if (!dateString) return 'N/A';
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };

    const dataForReport = {
      titulo: `Relatório de Avaliadores - ${feira.nome}`,
      feira,
      avaliadores,
      formatarData
    };

    const filename = `relatorio_avaliadores_${feira.nome.replace(/\s/g, '_')}`;

    await generatePdfReport(req, res, 'pdf-avaliadores', dataForReport, filename);

  } catch (err) {
    console.error('Erro ao gerar relatório de avaliadores:', err);
    if (!res.headersSent) {
      req.flash('error_msg', 'Erro ao gerar relatório: ' + err.message);
      res.redirect('/admin/dashboard?tab=relatorios');
    }
  }
});

// ===========================================
// ROTAS DE CONFIGURAÇÃO (ADMIN)
// ===========================================

// Atualizar informações da escola (POST)
router.post('/escola', verificarAdminEscola, async (req, res) => {
    const { id, nome, endereco, telefone, email, descricao, diretor, responsavel } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    try {
        if (id) {
            // Garante que apenas a escola associada ao admin logado possa ser atualizada
            const updatedEscola = await Escola.findOneAndUpdate({ _id: id, _id: adminEscolaId }, { // Dupla verificação do ID da escola
                nome, endereco, telefone, email, descricao, diretor, responsavel
            }, { new: true });

            if (!updatedEscola) {
                req.flash('error_msg', 'Informações da escola não encontradas ou você não tem permissão para editá-las.');
                return res.redirect('/admin/dashboard?tab=configuracoes');
            }

            req.flash('success_msg', 'Informações da escola atualizadas com sucesso!');
        } else {
            // Este bloco é para criar a primeira escola do admin (se ele não tiver uma)
            const newEscola = new Escola({
                nome, endereco, telefone, email, descricao, diretor, responsavel
            });
            await newEscola.save();

            // Vincula esta nova escola ao admin logado
            await Admin.findByIdAndUpdate(req.session.adminEscola.id, { escolaId: newEscola._id }); // USANDO escolaId AQUI
            req.session.adminEscola.escolaId = newEscola._id.toString(); // Atualiza a sessão imediatamente

            req.flash('success_msg', 'Informações da escola salvas com sucesso!');
        }
        res.redirect('/admin/dashboard?tab=configuracoes');
    } catch (err) {
        console.error('Erro ao salvar informações da escola:', err);
        req.flash('error_msg', 'Erro ao salvar informações da escola. Detalhes: ' + err.message);
        res.redirect('/admin/dashboard?tab=configuracoes');
    }
});

// Atualizar datas da feira ativa (POST)
router.post('/configuracoes/feiradata', verificarAdminEscola, async (req, res) => {
    const { feiraId, inicioFeira, fimFeira } = req.body;
    const adminEscolaId = req.session.adminEscola.escolaId;

    // Validação de ID antes de tentar a operação no banco
    if (!feiraId || !mongoose.Types.ObjectId.isValid(feiraId)) {
        req.flash('error_msg', 'ID da feira inválido para atualização de datas.');
        return res.redirect('/admin/dashboard?tab=configuracoes');
    }

    try {
        // Atualiza a feira, garantindo que ela pertence à escola do admin logado
        const updatedFeira = await Feira.findOneAndUpdate(
            { _id: feiraId, escolaId: adminEscolaId }, // Encontra pelo ID E pela escola (USANDO escolaId AQUI)
            { inicioFeira, fimFeira },
            { new: true }
        );

        if (!updatedFeira) {
            req.flash('error_msg', 'Feira não encontrada ou você não tem permissão para atualizar suas datas.');
            return res.redirect('/admin/dashboard?tab=configuracoes');
        }

        req.flash('success_msg', 'Datas da feira atualizadas com sucesso!');
        res.redirect('/admin/dashboard?tab=configuracoes');
    } catch (err) {
        console.error('Erro ao atualizar datas da feira:', err);
        req.flash('error_msg', 'Erro ao atualizar datas da feira. Detalhes: ' + err.message);
        res.redirect('/admin/dashboard?tab=configuracoes');
    }
});

// Atualizar dados da escola (POST)
router.post('/escola/atualizar', verificarAdminEscola, upload.single('logo'), async (req, res) => {
  const escolaId = req.session.adminEscola.escolaId;
  const { nome, telefone, endereco } = req.body;

  try {
    const updateData = {
      nome,
      telefone,
      endereco
    };

    // Se enviou imagem, converte para base64
    if (req.file) {
      const logoBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      updateData.logo = logoBase64;
    }

    await Escola.findByIdAndUpdate(escolaId, updateData);

    req.flash('success_msg', 'Dados da escola atualizados com sucesso!');
    res.redirect('/admin/dashboard?tab=tab-configuracoes');
  } catch (err) {
    console.error('Erro ao atualizar dados da escola:', err);
    req.flash('error_msg', 'Erro ao atualizar os dados da escola.');
    res.redirect('/admin/dashboard?tab=tab-configuracoes');
  }
});

router.post('/suporte', async (req, res) => {
  const { mensagem } = req.body;

  if (!mensagem) {
    req.flash('error_msg', 'Mensagem não pode estar vazia.');
    return res.redirect('/suporte');
  }

  let autorId = '';
let autorNome = '';
let autorEmail = '';
let autorTipo = '';

  if (req.session.superadmin) {
  autorNome = req.session.superadmin.nome;
  autorEmail = req.session.superadmin.email;
  autorTipo = 'SUPERADM';
} else if (req.session.adminEscola) {
  autorId = req.session.adminEscola._id;
  autorTipo = 'ADM';
} else {
  req.flash('error_msg', 'Usuário não autenticado.');
  return res.redirect('/suporte');
}

  await Mensagem.create({
  autorId,
  autorNome,
  autorEmail,
  autorTipo,
  mensagem,
  dataEnvio: new Date()
});

  req.flash('success_msg', 'Mensagem enviada com sucesso.');
  res.redirect('/suporte');
});

router.post('/dashboard/suporte', verificarAdminEscola, async (req, res) => {
  const { mensagem } = req.body;
  const autorId = req.session.adminEscola.id;

  if (!mensagem) {
    req.flash('error_msg', 'Por favor, escreva uma mensagem.');
    return res.redirect('/admin/dashboard?tab=suporte');
  }
  console.log('Sessão atual:', req.session);

  try {
    const novaMensagem = new Mensagem({
      autorId,
      autorTipo: 'ADM',
      mensagem
    });

    await novaMensagem.save();

    res.redirect('/admin/dashboard?tab=suporte');
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    req.flash('error_msg', 'Erro ao enviar mensagem.');
    res.redirect('/admin/dashboard?tab=suporte');
  }
});


module.exports = router;

// routes/avaliador.js

const express = require('express');
const router = express.Router();

const mongoose = require('mongoose');

const Avaliador = require('../models/Avaliador');
const Projeto = require('../models/Projeto');
const Avaliacao = require('../models/Avaliacao');
const Criterio = require('../models/Criterio');
const Feira = require('../models/Feira');
const Escola = require('../models/Escola');
const Feedback = require('../models/Feedback');

const QRCode = require('qrcode');


// ============================================================
// MIDDLEWARE
// ============================================================

// Verifica sessão do avaliador e se o avaliador continua ativo
async function verificarAvaliador(req, res, next) {
    try {
        if (res.headersSent) {
            console.warn('Headers já enviados em verificarAvaliador, abortando.');
            return;
        }

        if (req.session && req.session.avaliador) {
            const avaliador = await Avaliador.findById(
                req.session.avaliador.id
            );

            if (avaliador && avaliador.ativo) {
                // Disponibiliza o avaliador completo para as rotas
                res.locals.avaliador = avaliador;
                return next();
            }
        }

        req.flash(
            'error_msg',
            'Acesso não autorizado. Informe seu PIN.'
        );

        return res.redirect('/avaliador/login');

    } catch (err) {
        console.error('Erro no middleware verificarAvaliador:', err);

        if (!res.headersSent) {
            req.flash(
                'error_msg',
                'Erro ao verificar acesso do avaliador.'
            );

            return res.redirect('/avaliador/login');
        }
    }
}


// ============================================================
// LOGIN
// ============================================================

// Tela de login via PIN
router.get('/login', (req, res) => {
    res.render('avaliador/login', {
        titulo: 'Login do Avaliador',
        layout: 'layouts/public',
        error_msg: req.flash('error_msg'),
        success_msg: req.flash('success_msg')
    });
});


// Validação do PIN
router.post('/login', async (req, res) => {
    const { pin } = req.body;

    try {
        const avaliador = await Avaliador.findOne({
            pin,
            ativo: true
        }).populate('projetosAtribuidos');

        if (!avaliador) {
            req.flash(
                'error_msg',
                'PIN inválido ou avaliador inativo.'
            );

            return res.redirect('/avaliador/login');
        }

        // Salva somente os dados necessários na sessão
        req.session.avaliador = {
            id: avaliador._id,
            nome: avaliador.nome,
            escolaId: avaliador.escolaId.toString(),
            feira: avaliador.feira.toString()
        };

        req.flash(
            'success_msg',
            'Login realizado com sucesso!'
        );

        return res.redirect('/avaliador/dashboard');

    } catch (err) {
        console.error('Erro no login do avaliador:', err);

        if (!res.headersSent) {
            req.flash(
                'error_msg',
                'Erro ao tentar autenticar. Detalhes: ' + err.message
            );

            return res.redirect('/avaliador/login');
        }
    }
});


// ============================================================
// DASHBOARD DO AVALIADOR
// ============================================================

router.get('/dashboard', verificarAvaliador, async (req, res) => {
    if (res.headersSent) return;

    try {
        const avaliadorData = res.locals.avaliador;

        // Popula os projetos atribuídos
        await avaliadorData.populate('projetosAtribuidos');

        /*
         * IMPORTANTE:
         *
         * NÃO usamos mais:
         *
         * Criterio.find({
         *     feira: feira,
         *     escolaId: escolaId
         * })
         *
         * para descobrir quantos critérios um projeto possui.
         *
         * Cada projeto possui seu próprio array:
         *
         * projeto.criterios
         *
         * Portanto, cada projeto é tratado individualmente.
         */

        const projetosComStatus = await Promise.all(
            avaliadorData.projetosAtribuidos.map(async (projeto) => {

                // ------------------------------------------------
                // CRITÉRIOS DO PROJETO
                // ------------------------------------------------

                const criteriosDoProjeto = Array.isArray(projeto.criterios)
                    ? projeto.criterios
                    : [];

                const totalCriteriosProjeto =
                    criteriosDoProjeto.length;


                // ------------------------------------------------
                // BUSCA A AVALIAÇÃO DESTE PROJETO
                // ------------------------------------------------

                const avaliacao = await Avaliacao.findOne({
                    avaliador: avaliadorData._id,
                    projeto: projeto._id
                });


                // ------------------------------------------------
                // STATUS
                // ------------------------------------------------

                let statusAvaliacao = 'Pendente';
                let corStatus = 'text-yellow-600';

                let criteriosAvaliadosComNota = 0;

                if (avaliacao && Array.isArray(avaliacao.itens)) {

                    criteriosAvaliadosComNota =
                        avaliacao.itens.filter(item =>
                            item.nota !== undefined &&
                            item.nota !== null &&
                            item.nota >= 5 &&
                            item.nota <= 10
                        ).length;
                }


                // Projeto sem critérios
                if (totalCriteriosProjeto === 0) {

                    if (avaliacao) {
                        statusAvaliacao = 'Avaliado';
                        corStatus = 'text-green-600';
                    }

                } else {

                    // Todos os critérios do projeto foram avaliados
                    if (
                        criteriosAvaliadosComNota ===
                        totalCriteriosProjeto
                    ) {

                        statusAvaliacao = 'Avaliado';
                        corStatus = 'text-green-600';

                    // Pelo menos um critério foi avaliado
                    } else if (criteriosAvaliadosComNota > 0) {

                        statusAvaliacao = 'Em Processo';
                        corStatus = 'text-orange-600';
                    }
                }


                return {
                    ...projeto.toObject(),

                    statusAvaliacao,

                    corStatus,

                    avaliadoPorAvaliador:
                        statusAvaliacao === 'Avaliado',

                    // Informações extras úteis para a view
                    totalCriterios: totalCriteriosProjeto,

                    criteriosAvaliados:
                        criteriosAvaliadosComNota
                };
            })
        );


        const todosProjetosAvaliados =
            projetosComStatus.length > 0 &&
            projetosComStatus.every(
                projeto =>
                    projeto.statusAvaliacao === 'Avaliado'
            );


        res.render('avaliador/dashboard', {
            titulo: 'Meus Projetos',

            projetos: projetosComStatus,

            avaliador: avaliadorData,

            todosProjetosAvaliados,

            layout: 'layouts/public',

            error_msg: req.flash('error_msg'),

            success_msg: req.flash('success_msg')
        });

    } catch (err) {

        console.error(
            'Erro ao carregar projetos do avaliador:',
            err
        );

        if (!res.headersSent) {

            req.flash(
                'error_msg',
                'Erro ao carregar seus projetos. Detalhes: ' +
                err.message
            );

            return res.redirect('/avaliador/login');
        }
    }
});


// ============================================================
// TELA DE AVALIAÇÃO DO PROJETO
// ============================================================

router.get(
    '/avaliar/:projetoId',
    verificarAvaliador,
    async (req, res) => {

        if (res.headersSent) return;

        try {

            const { projetoId } = req.params;

            const avaliadorData =
                res.locals.avaliador;


            // ------------------------------------------------
            // VALIDA ID
            // ------------------------------------------------

            if (
                !projetoId ||
                !mongoose.Types.ObjectId.isValid(projetoId)
            ) {

                req.flash(
                    'error_msg',
                    'ID do projeto inválido.'
                );

                return res.redirect('/avaliador/dashboard');
            }


            // ------------------------------------------------
            // BUSCA PROJETO
            // ------------------------------------------------

            const projeto =
                await Projeto.findById(projetoId).lean();


            // ------------------------------------------------
            // VALIDA ESCOLA E FEIRA
            // ------------------------------------------------

            if (
                !projeto ||
                String(projeto.escolaId) !==
                    String(avaliadorData.escolaId) ||
                String(projeto.feira) !==
                    String(avaliadorData.feira)
            ) {

                req.flash(
                    'error_msg',
                    'Projeto não encontrado ou não pertence à sua escola/feira.'
                );

                return res.redirect('/avaliador/dashboard');
            }


            // ------------------------------------------------
            // VERIFICA SE O PROJETO ESTÁ ATRIBUÍDO AO AVALIADOR
            // ------------------------------------------------

            const projetoAtribuido =
                await Avaliador.exists({
                    _id: avaliadorData._id,
                    projetosAtribuidos: projeto._id
                });

            if (!projetoAtribuido) {

                req.flash(
                    'error_msg',
                    'Este projeto não está atribuído a você.'
                );

                return res.redirect('/avaliador/dashboard');
            }


            // =================================================
            // CORREÇÃO PRINCIPAL
            //
            // BUSCAR SOMENTE OS CRITÉRIOS DO PROJETO
            // =================================================

            const idsCriteriosProjeto =
                Array.isArray(projeto.criterios)
                    ? projeto.criterios
                    : [];


            const criterios = await Criterio.find({

                // SOMENTE critérios vinculados ao projeto
                _id: {
                    $in: idsCriteriosProjeto
                },

                // Segurança adicional
                feira: projeto.feira,

                escolaId: projeto.escolaId

            }).sort({
                nome: 1
            }).lean();


            // ------------------------------------------------
            // BUSCA AVALIAÇÃO EXISTENTE
            // ------------------------------------------------

            const avaliacaoExistente =
                await Avaliacao.findOne({
                    avaliador: avaliadorData._id,
                    projeto: projetoId,
                    feira: projeto.feira,
                    escolaId: projeto.escolaId
                }).populate('itens.criterio');


            // ------------------------------------------------
            // RENDER
            // ------------------------------------------------

            res.render('avaliador/avaliar_projeto', {

                titulo:
                    `Avaliar: ${projeto.titulo}`,

                projeto,

                criterios,

                avaliador: avaliadorData,

                avaliacaoExistente,

                layout: 'layouts/public',

                error_msg:
                    req.flash('error_msg'),

                success_msg:
                    req.flash('success_msg')
            });

        } catch (err) {

            console.error(
                'Erro ao carregar página de avaliação:',
                err
            );

            if (!res.headersSent) {

                req.flash(
                    'error_msg',
                    'Erro ao carregar a página de avaliação do projeto. Detalhes: ' +
                    err.message
                );

                return res.redirect('/avaliador/dashboard');
            }
        }
    }
);


// ============================================================
// SALVAR AVALIAÇÃO
// ============================================================

router.post(
    '/avaliar/:projetoId',
    verificarAvaliador,
    async (req, res) => {

        const { projetoId } = req.params;

        try {

            const avaliadorData =
                res.locals.avaliador;

            const {
                criterios: criteriosRecebidos
            } = req.body;


            // ------------------------------------------------
            // VERIFICA SE O AVALIADOR JÁ FINALIZOU
            // ------------------------------------------------

            if (avaliadorData.statusAvaliacaoGeral) {

                req.flash(
                    'error_msg',
                    'Suas avaliações já foram finalizadas. Não é possível editar.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // ------------------------------------------------
            // VALIDA ID
            // ------------------------------------------------

            if (
                !projetoId ||
                !mongoose.Types.ObjectId.isValid(projetoId)
            ) {

                req.flash(
                    'error_msg',
                    'ID do projeto inválido.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // ------------------------------------------------
            // BUSCA PROJETO
            // ------------------------------------------------

            const projeto =
                await Projeto.findById(projetoId).lean();


            // ------------------------------------------------
            // VALIDA ESCOLA E FEIRA
            // ------------------------------------------------

            if (
                !projeto ||
                String(projeto.escolaId) !==
                    String(avaliadorData.escolaId) ||
                String(projeto.feira) !==
                    String(avaliadorData.feira)
            ) {

                req.flash(
                    'error_msg',
                    'Projeto não encontrado ou não pertence à sua escola/feira.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // ------------------------------------------------
            // VERIFICA SE PROJETO ESTÁ ATRIBUÍDO
            // ------------------------------------------------

            const projetoAtribuido =
                await Avaliador.exists({
                    _id: avaliadorData._id,
                    projetosAtribuidos: projeto._id
                });

            if (!projetoAtribuido) {

                req.flash(
                    'error_msg',
                    'Este projeto não está atribuído a você.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // =================================================
            // CRITÉRIOS OFICIAIS DO PROJETO
            //
            // IMPORTANTE:
            // NÃO pegar todos os critérios da feira.
            // =================================================

            const idsCriteriosProjeto =
                Array.isArray(projeto.criterios)
                    ? projeto.criterios
                    : [];


            const criteriosOficiais =
                await Criterio.find({

                    _id: {
                        $in: idsCriteriosProjeto
                    },

                    feira: projeto.feira,

                    escolaId: projeto.escolaId

                }).lean();


            // ------------------------------------------------
            // MAPA DOS CRITÉRIOS VÁLIDOS
            // ------------------------------------------------

            const criteriosValidos =
                new Set(
                    criteriosOficiais.map(
                        criterio =>
                            String(criterio._id)
                    )
                );


            // =================================================
            // BLOQUEIA CRITÉRIOS QUE NÃO PERTENCEM AO PROJETO
            // =================================================

            if (criteriosRecebidos) {

                const idsRecebidos =
                    Object.keys(criteriosRecebidos);

                const criterioInvalido =
                    idsRecebidos.find(
                        criterioId =>
                            !criteriosValidos.has(
                                String(criterioId)
                            )
                    );

                if (criterioInvalido) {

                    console.warn(
                        'Tentativa de enviar critério que não pertence ao projeto:',
                        {
                            avaliador:
                                avaliadorData._id,

                            projeto:
                                projeto._id,

                            criterio:
                                criterioInvalido
                        }
                    );

                    req.flash(
                        'error_msg',
                        'Foi enviado um critério que não pertence a este projeto.'
                    );

                    return res.redirect(
                        `/avaliador/avaliar/${projetoId}`
                    );
                }
            }


            // ------------------------------------------------
            // BUSCA AVALIAÇÃO EXISTENTE
            // ------------------------------------------------

            let avaliacaoExistente =
                await Avaliacao.findOne({
                    avaliador: avaliadorData._id,
                    projeto: projetoId,
                    feira: projeto.feira,
                    escolaId: projeto.escolaId
                });


            // ------------------------------------------------
            // CRIA NOVA AVALIAÇÃO
            // ------------------------------------------------

            if (!avaliacaoExistente) {

                avaliacaoExistente =
                    new Avaliacao({

                        avaliador:
                            avaliadorData._id,

                        projeto:
                            projetoId,

                        feira:
                            projeto.feira,

                        escolaId:
                            projeto.escolaId,

                        itens: []
                    });
            }


            // ------------------------------------------------
            // COPIA ITENS EXISTENTES
            // ------------------------------------------------

            const novosItensAvaliacao =
                avaliacaoExistente.itens.map(
                    item => ({
                        ...item.toObject()
                    })
                );


            // ------------------------------------------------
            // MAPA DOS ITENS EXISTENTES
            // ------------------------------------------------

            const novosItensMap =
                new Map(
                    novosItensAvaliacao.map(
                        item => [
                            String(item.criterio),
                            item
                        ]
                    )
                );


            // =================================================
            // PROCESSA SOMENTE OS CRITÉRIOS DO PROJETO
            // =================================================

            for (const criterio of criteriosOficiais) {

                const criterioId =
                    String(criterio._id);


                const dadosRecebidosParaCriterio =
                    criteriosRecebidos
                        ? criteriosRecebidos[criterioId]
                        : undefined;


                // ------------------------------------------------
                // CRITÉRIO NÃO ENVIADO
                // ------------------------------------------------

                if (!dadosRecebidosParaCriterio) {
                    continue;
                }


                const {
                    nota,
                    comentario
                } = dadosRecebidosParaCriterio;


                // ------------------------------------------------
                // NOTA VAZIA
                // ------------------------------------------------

                if (
                    nota === undefined ||
                    nota === null ||
                    nota === ''
                ) {

                    const itemParaAtualizar =
                        novosItensMap.get(
                            criterioId
                        );

                    if (itemParaAtualizar) {

                        itemParaAtualizar.comentario =
                            comentario || '';
                    }

                    continue;
                }


                // ------------------------------------------------
                // CONVERTE NOTA
                // ------------------------------------------------

                const notaNum =
                    parseInt(nota, 10);


                // ------------------------------------------------
                // VALIDA NOTA
                // ------------------------------------------------

                if (
                    isNaN(notaNum) ||
                    notaNum < 5 ||
                    notaNum > 10
                ) {

                    req.flash(
                        'error_msg',
                        `Nota inválida para o critério "${criterio.nome}". As notas devem ser entre 5 e 10.`
                    );

                    return res.redirect(
                        `/avaliador/avaliar/${projetoId}`
                    );
                }


                // ------------------------------------------------
                // ATUALIZA ITEM EXISTENTE
                // ------------------------------------------------

                const itemParaAtualizar =
                    novosItensMap.get(
                        criterioId
                    );


                if (itemParaAtualizar) {

                    itemParaAtualizar.nota =
                        notaNum;

                    itemParaAtualizar.comentario =
                        comentario || '';

                } else {

                    // ------------------------------------------------
                    // ADICIONA NOVO ITEM
                    // ------------------------------------------------

                    novosItensAvaliacao.push({

                        criterio:
                            criterio._id,

                        nota:
                            notaNum,

                        comentario:
                            comentario || ''
                    });
                }
            }


            // =================================================
            // LIMPA EVENTUAIS ITENS ANTIGOS DE CRITÉRIOS
            // QUE NÃO PERTENCEM MAIS AO PROJETO
            //
            // Isso é importante caso o projeto tenha tido seus
            // critérios alterados depois de uma avaliação.
            // =================================================

            avaliacaoExistente.itens =
                novosItensAvaliacao.filter(
                    item =>
                        criteriosValidos.has(
                            String(item.criterio)
                        )
                );


            // ------------------------------------------------
            // MARCA AVALIAÇÃO COMO INICIADA
            // ------------------------------------------------

            avaliacaoExistente.finalizadaPorAvaliador =
                avaliacaoExistente.itens.some(
                    item =>
                        item.nota !== undefined &&
                        item.nota !== null
                );


            // ------------------------------------------------
            // SALVA
            // ------------------------------------------------

            await avaliacaoExistente.save();


            req.flash(
                'success_msg',
                'Avaliação salva com sucesso!'
            );

            return res.redirect(
                '/avaliador/dashboard'
            );

        } catch (err) {

            console.error(
                'Erro ao salvar avaliação do projeto:',
                err
            );

            if (!res.headersSent) {

                if (err.name === 'ValidationError') {

                    const messages =
                        Object.values(err.errors)
                            .map(val => val.message);

                    req.flash(
                        'error_msg',
                        messages.join(', ')
                    );

                } else {

                    req.flash(
                        'error_msg',
                        'Erro ao salvar a avaliação. Detalhes: ' +
                        err.message
                    );
                }

                return res.redirect(
                    `/avaliador/avaliar/${projetoId}`
                );
            }
        }
    }
);


// ============================================================
// FINALIZAR TODAS AS AVALIAÇÕES
// ============================================================

router.post(
    '/finalizar-avaliacoes',
    verificarAvaliador,
    async (req, res) => {

        try {

            const avaliadorData =
                res.locals.avaliador;


            // ------------------------------------------------
            // VERIFICA SE JÁ FINALIZOU
            // ------------------------------------------------

            if (avaliadorData.statusAvaliacaoGeral) {

                req.flash(
                    'error_msg',
                    'Suas avaliações já foram finalizadas.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // ------------------------------------------------
            // BUSCA AVALIADOR COM PROJETOS
            // ------------------------------------------------

            const avaliadorCompleto =
                await Avaliador.findById(
                    avaliadorData._id
                ).populate('projetosAtribuidos');


            if (!avaliadorCompleto) {

                req.flash(
                    'error_msg',
                    'Avaliador não encontrado.'
                );

                return res.redirect(
                    '/avaliador/login'
                );
            }


            const projetosAtribuidos =
                avaliadorCompleto.projetosAtribuidos || [];


            // ------------------------------------------------
            // SEM PROJETOS
            // ------------------------------------------------

            if (projetosAtribuidos.length === 0) {

                req.flash(
                    'error_msg',
                    'Você não possui projetos atribuídos para avaliar.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // ------------------------------------------------
            // PROJETOS INCOMPLETOS
            // ------------------------------------------------

            const projetosNaoCompletos = [];


            // =================================================
            // VERIFICA CADA PROJETO INDIVIDUALMENTE
            // =================================================

            for (
                const projeto
                of projetosAtribuidos
            ) {

                // --------------------------------------------
                // CRITÉRIOS DO PROJETO
                // --------------------------------------------

                const totalCriteriosProjeto =
                    Array.isArray(projeto.criterios)
                        ? projeto.criterios.length
                        : 0;


                // --------------------------------------------
                // BUSCA AVALIAÇÃO
                // --------------------------------------------

                const avaliacao =
                    await Avaliacao.findOne({

                        avaliador:
                            avaliadorData._id,

                        projeto:
                            projeto._id,

                        feira:
                            projeto.feira,

                        escolaId:
                            projeto.escolaId
                    });


                // --------------------------------------------
                // CONTA CRITÉRIOS AVALIADOS
                // --------------------------------------------

                const criteriosAvaliados =
                    avaliacao &&
                    Array.isArray(avaliacao.itens)

                        ? avaliacao.itens.filter(
                            item =>
                                item.nota !== undefined &&
                                item.nota !== null &&
                                item.nota >= 5 &&
                                item.nota <= 10
                        ).length

                        : 0;


                // --------------------------------------------
                // PROJETO SEM CRITÉRIOS
                // --------------------------------------------

                if (totalCriteriosProjeto === 0) {

                    if (!avaliacao) {

                        projetosNaoCompletos.push(
                            projeto._id
                        );
                    }

                    continue;
                }


                // --------------------------------------------
                // PROJETO COM CRITÉRIOS
                // --------------------------------------------

                if (
                    criteriosAvaliados !==
                    totalCriteriosProjeto
                ) {

                    projetosNaoCompletos.push(
                        projeto._id
                    );
                }
            }


            // =================================================
            // SE EXISTEM PROJETOS PENDENTES
            // =================================================

            if (
                projetosNaoCompletos.length > 0
            ) {

                const projetosTitles =
                    await Projeto.find({
                        _id: {
                            $in: projetosNaoCompletos
                        }
                    })
                    .select('titulo')
                    .lean();


                const titles =
                    projetosTitles
                        .map(p => p.titulo)
                        .join(', ');


                req.flash(
                    'error_msg',
                    `Você precisa avaliar TODOS os critérios de TODOS os projetos atribuídos antes de finalizar. Projetos pendentes: ${titles}.`
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }


            // =================================================
            // TUDO COMPLETO
            // =================================================

            avaliadorCompleto.ativo = false;

            avaliadorCompleto.statusAvaliacaoGeral = true;

            await avaliadorCompleto.save();


            // ------------------------------------------------
            // ENCERRA SESSÃO
            // ------------------------------------------------

            req.session.destroy(err => {

                if (err) {

                    console.error(
                        'Erro ao encerrar sessão do avaliador:',
                        err
                    );

                    if (!res.headersSent) {
                        return res.redirect(
                            '/avaliador/login'
                        );
                    }

                    return;
                }


                if (!res.headersSent) {

                    return res.redirect(
                        '/avaliador/agradecimento'
                    );
                }
            });

        } catch (err) {

            console.error(
                'Erro ao finalizar avaliações do avaliador:',
                err
            );

            if (!res.headersSent) {

                req.flash(
                    'error_msg',
                    'Erro ao tentar finalizar avaliações. Detalhes: ' +
                    err.message
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }
        }
    }
);


// ============================================================
// LOGOUT
// ============================================================

router.get('/logout', (req, res) => {

    req.session.destroy(err => {

        if (err) {
            console.error(
                'Erro ao encerrar sessão do avaliador:',
                err
            );
        }

        if (!res.headersSent) {

            req.flash(
                'success_msg',
                'Você foi desconectado com sucesso.'
            );

            return res.redirect(
                '/avaliador/login'
            );
        }
    });
});


// ============================================================
// AGRADECIMENTO
// ============================================================

router.get('/agradecimento', (req, res) => {

    if (res.headersSent) return;

    res.render('avaliador/agradecimento', {

        layout: 'layouts/public',

        titulo:
            'Obrigado por sua participação'
    });
});


// ============================================================
// ACESSO DIRETO VIA PIN / QR CODE
// ============================================================

router.get(
    '/acesso-direto/:pin',
    async (req, res) => {

        try {

            const { pin } = req.params;


            const avaliador =
                await Avaliador.findOne({
                    pin,
                    ativo: true
                }).populate('projetosAtribuidos');


            if (!avaliador) {

                return res.status(404).send(
                    'PIN inválido ou avaliador desativado.'
                );
            }


            // Define sessão
            req.session.avaliador = {

                id:
                    avaliador._id,

                nome:
                    avaliador.nome,

                escolaId:
                    avaliador.escolaId.toString(),

                feira:
                    avaliador.feira.toString()
            };


            return res.redirect(
                '/avaliador/dashboard'
            );

        } catch (err) {

            console.error(
                'Erro no acesso direto via PIN:',
                err
            );

            return res.status(500).send(
                'Erro ao acessar o sistema.'
            );
        }
    }
);


// ============================================================
// FEEDBACK
// ============================================================

router.post('/feedback', async (req, res) => {

    try {

        const {
            tipo,
            mensagem,
            categoria,
            nome,
            email
        } = req.body;


        const novoFeedback =
            new Feedback({

                tipo:
                    tipo || 'Avaliador',

                mensagem,

                categoria,

                nome:
                    nome?.trim() || '',

                email:
                    email?.trim() || ''
            });


        await novoFeedback.save();


        req.flash(
            'success_msg',
            'Feedback enviado com sucesso!'
        );


        return res.redirect(
            '/avaliador/agradecimento'
        );

    } catch (error) {

        console.error(
            'Erro ao enviar feedback:',
            error
        );


        req.flash(
            'error_msg',
            'Ocorreu um erro ao enviar o feedback. Tente novamente.'
        );


        return res.redirect(
            '/avaliador/agradecimento'
        );
    }
});


module.exports = router;

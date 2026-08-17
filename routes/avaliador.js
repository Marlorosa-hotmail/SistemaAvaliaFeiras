// routes/avaliador.js

const express = require('express');
const router = express.Router();

const Avaliador = require('../models/Avaliador');
const Projeto = require('../models/Projeto');
const Avaliacao = require('../models/Avaliacao');
const Criterio = require('../models/Criterio');
const Feira = require('../models/Feira');
const Escola = require('../models/Escola');
const QRCode = require('qrcode');
const Feedback = require('../models/Feedback');


// ============================================================
// MIDDLEWARE - VERIFICAR SESSÃO DO AVALIADOR
// ============================================================

async function verificarAvaliador(req, res, next) {
    if (res.headersSent) {
        console.warn('Headers já enviados em verificarAvaliador, abortando.');
        return;
    }

    try {
        if (req.session && req.session.avaliador) {
            const avaliador = await Avaliador.findById(
                req.session.avaliador.id
            );

            if (avaliador && avaliador.ativo) {
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
        console.error('Erro ao verificar avaliador:', err);

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

router.get('/login', (req, res) => {
    res.render('avaliador/login', {
        titulo: 'Login do Avaliador',
        layout: 'layouts/public',
        error_msg: req.flash('error_msg'),
        success_msg: req.flash('success_msg')
    });
});


// ============================================================
// VALIDAÇÃO DO PIN
// ============================================================

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
        console.error(
            'Erro no login do avaliador:',
            err
        );

        if (!res.headersSent) {
            req.flash(
                'error_msg',
                'Erro ao tentar autenticar. Detalhes: ' +
                err.message
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

        // Carrega os projetos atribuídos
        await avaliadorData.populate('projetosAtribuidos');

        /*
         * IMPORTANTE:
         *
         * Não usamos mais os critérios da feira para determinar
         * se um projeto foi avaliado.
         *
         * Cada projeto possui sua própria lista:
         *
         * projeto.criterios
         *
         * Portanto:
         *
         * Projeto A -> 1 critério
         * Projeto B -> 3 critérios
         * Projeto C -> 6 critérios
         */

        const projetosComStatus = await Promise.all(
            avaliadorData.projetosAtribuidos.map(
                async projeto => {

                    const avaliacao = await Avaliacao.findOne({
                        avaliador: avaliadorData._id,
                        projeto: projeto._id
                    });

                    const totalCriterios =
                        Array.isArray(projeto.criterios)
                            ? projeto.criterios.length
                            : 0;

                    let criteriosAvaliadosComNota = 0;

                    if (avaliacao && Array.isArray(avaliacao.itens)) {
                        criteriosAvaliadosComNota =
                            avaliacao.itens.filter(
                                item =>
                                    item.nota !== undefined &&
                                    item.nota !== null &&
                                    item.nota >= 5 &&
                                    item.nota <= 10
                            ).length;
                    }

                    let statusAvaliacao = 'Pendente';
                    let corStatus = 'text-yellow-600';

                    if (totalCriterios === 0) {
                        if (avaliacao) {
                            statusAvaliacao = 'Avaliado';
                            corStatus = 'text-green-600';
                        }
                    } else if (
                        criteriosAvaliadosComNota === totalCriterios
                    ) {
                        statusAvaliacao = 'Avaliado';
                        corStatus = 'text-green-600';
                    } else if (
                        criteriosAvaliadosComNota > 0
                    ) {
                        statusAvaliacao = 'Em Processo';
                        corStatus = 'text-orange-600';
                    }

                    return {
                        ...projeto.toObject(),

                        statusAvaliacao,

                        corStatus,

                        avaliadoPorAvaliador:
                            statusAvaliacao === 'Avaliado'
                    };
                }
            )
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
// TELA DE AVALIAÇÃO DE UM PROJETO
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

            /*
             * Busca o projeto.
             *
             * Não buscamos os critérios diretamente pela feira.
             */
            const projeto = await Projeto.findById(
                projetoId
            ).lean();

            if (
                !projeto ||
                String(projeto.escolaId) !==
                    String(avaliadorData.escolaId) ||
                String(projeto.feira) !==
                    String(avaliadorData.feira)
            ) {
                req.flash(
                    'error_msg',
                    'Projeto não encontrado ou não pertence à sua escola/feira, ou não está atribuído a você.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }

            /*
             * =====================================================
             * CORREÇÃO PRINCIPAL
             * =====================================================
             *
             * O projeto possui sua própria lista de critérios:
             *
             * projeto.criterios
             *
             * Portanto NÃO fazemos:
             *
             * Criterio.find({ feira: projeto.feira })
             *
             * pois isso retornaria TODOS os critérios da feira.
             */

            const criteriosDoProjeto =
                Array.isArray(projeto.criterios)
                    ? projeto.criterios
                    : [];

            const criterios =
                criteriosDoProjeto.length > 0
                    ? await Criterio.find({
                        _id: {
                            $in: criteriosDoProjeto
                        },
                        feira: projeto.feira,
                        escolaId: projeto.escolaId
                    }).sort('nome').lean()
                    : [];

            /*
             * Busca avaliação existente.
             */
            const avaliacaoExistente =
                await Avaliacao.findOne({
                    avaliador: avaliadorData._id,
                    projeto: projetoId,
                    feira: projeto.feira,
                    escolaId: projeto.escolaId
                }).populate('itens.criterio');

            res.render(
                'avaliador/avaliar_projeto',
                {
                    titulo:
                        `Avaliar: ${projeto.titulo}`,

                    projeto,

                    criterios,

                    avaliador:
                        avaliadorData,

                    avaliacaoExistente,

                    layout:
                        'layouts/public',

                    error_msg:
                        req.flash('error_msg'),

                    success_msg:
                        req.flash('success_msg')
                }
            );

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

                return res.redirect(
                    '/avaliador/dashboard'
                );
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

            if (avaliadorData.statusAvaliacaoGeral) {
                req.flash(
                    'error_msg',
                    'Suas avaliações já foram finalizadas. Não é possível editar.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }

            /*
             * Busca o projeto.
             */
            const projeto =
                await Projeto.findById(
                    projetoId
                ).lean();

            if (
                !projeto ||
                String(projeto.escolaId) !==
                    String(avaliadorData.escolaId) ||
                String(projeto.feira) !==
                    String(avaliadorData.feira)
            ) {
                req.flash(
                    'error_msg',
                    'Projeto não encontrado ou não pertence à sua escola/feira, ou não está atribuído a você.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }

            /*
             * =====================================================
             * CRITÉRIOS OFICIAIS DO PROJETO
             * =====================================================
             */

            const criteriosDoProjeto =
                Array.isArray(projeto.criterios)
                    ? projeto.criterios
                    : [];

            const criteriosOficiais =
                criteriosDoProjeto.length > 0
                    ? await Criterio.find({
                        _id: {
                            $in: criteriosDoProjeto
                        },
                        feira: projeto.feira,
                        escolaId: projeto.escolaId
                    })
                    : [];

            /*
             * Cria um Set para validar rapidamente
             * quais critérios pertencem ao projeto.
             */

            const criteriosPermitidos =
                new Set(
                    criteriosOficiais.map(
                        criterio =>
                            String(criterio._id)
                    )
                );

            /*
             * Busca avaliação existente.
             */

            let avaliacaoExistente =
                await Avaliacao.findOne({
                    avaliador: avaliadorData._id,
                    projeto: projetoId,
                    feira: projeto.feira,
                    escolaId: projeto.escolaId
                });

            /*
             * Se não existir, cria uma avaliação nova.
             */

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

            /*
             * =====================================================
             * LIMPA ITENS QUE NÃO PERTENCEM MAIS AO PROJETO
             * =====================================================
             *
             * Isso é importante caso uma avaliação tenha sido salva
             * anteriormente quando o sistema ainda considerava
             * todos os critérios da feira.
             */

            const novosItensAvaliacao =
                avaliacaoExistente.itens
                    .filter(
                        item =>
                            criteriosPermitidos.has(
                                String(item.criterio)
                            )
                    )
                    .map(
                        item => ({
                            ...item.toObject()
                        })
                    );

            const novosItensMap =
                new Map(
                    novosItensAvaliacao.map(
                        item => [
                            String(item.criterio),
                            item
                        ]
                    )
                );

            /*
             * =====================================================
             * PROCESSA SOMENTE OS CRITÉRIOS DO PROJETO
             * =====================================================
             */

            for (
                const criterio
                of criteriosOficiais
            ) {

                const criterioId =
                    String(criterio._id);

                const dadosRecebidosParaCriterio =
                    criteriosRecebidos
                        ? criteriosRecebidos[
                            criterioId
                        ]
                        : undefined;

                if (!dadosRecebidosParaCriterio) {
                    continue;
                }

                const {
                    nota,
                    comentario
                } =
                    dadosRecebidosParaCriterio;

                /*
                 * Nota vazia.
                 */

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

                const notaNum =
                    parseInt(nota, 10);

                /*
                 * Validação da nota.
                 */

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

                /*
                 * Atualiza item existente.
                 */

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

                    /*
                     * Cria novo item.
                     */

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

            /*
             * =====================================================
             * GARANTIA EXTRA DE SEGURANÇA
             * =====================================================
             *
             * Mesmo que alguém tente enviar manualmente pelo
             * navegador um critério que não pertence ao projeto,
             * ele não será salvo.
             */

            avaliacaoExistente.itens =
                novosItensAvaliacao.filter(
                    item =>
                        criteriosPermitidos.has(
                            String(item.criterio)
                        )
                );

            /*
             * Marca a avaliação como iniciada/salva
             * se existir pelo menos uma nota.
             */

            avaliacaoExistente.finalizadaPorAvaliador =
                avaliacaoExistente.itens.some(
                    item =>
                        item.nota !== undefined &&
                        item.nota !== null
                );

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

                if (
                    err.name ===
                    'ValidationError'
                ) {

                    const messages =
                        Object.values(
                            err.errors
                        ).map(
                            val =>
                                val.message
                        );

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

            if (
                avaliadorData.statusAvaliacaoGeral
            ) {

                req.flash(
                    'error_msg',
                    'Suas avaliações já foram finalizadas.'
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }

            /*
             * Carrega projetos atribuídos.
             */

            const avaliadorCompleto =
                await Avaliador.findById(
                    avaliadorData._id
                ).populate(
                    'projetosAtribuidos'
                );

            const projetosAtribuidos =
                avaliadorCompleto.projetosAtribuidos;

            const projetosNaoCompletos = [];

            /*
             * Cada projeto será analisado individualmente.
             */

            for (
                const projeto
                of projetosAtribuidos
            ) {

                const totalCriteriosProjeto =
                    Array.isArray(
                        projeto.criterios
                    )
                        ? projeto.criterios.length
                        : 0;

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

                /*
                 * Projeto sem critérios.
                 *
                 * Consideramos completo caso exista
                 * uma avaliação.
                 */

                if (
                    totalCriteriosProjeto === 0
                ) {

                    if (!avaliacao) {
                        projetosNaoCompletos.push(
                            projeto._id
                        );
                    }

                    continue;
                }

                /*
                 * Quantidade de notas válidas.
                 */

                const notasValidas =
                    avaliacao &&
                    Array.isArray(
                        avaliacao.itens
                    )
                        ? avaliacao.itens.filter(
                            item =>
                                item.nota !==
                                    undefined &&
                                item.nota !==
                                    null &&
                                item.nota >= 5 &&
                                item.nota <= 10
                        ).length
                        : 0;

                /*
                 * O projeto só está completo se a quantidade
                 * de notas for exatamente igual à quantidade
                 * de critérios daquele projeto.
                 */

                if (
                    notasValidas !==
                    totalCriteriosProjeto
                ) {

                    projetosNaoCompletos.push(
                        projeto._id
                    );
                }
            }

            /*
             * Se houver projetos pendentes,
             * informa ao avaliador.
             */

            if (
                projetosNaoCompletos.length > 0
            ) {

                const projetosTitles =
                    await Projeto.find({
                        _id: {
                            $in:
                                projetosNaoCompletos
                        }
                    })
                    .select('titulo')
                    .lean();

                const titles =
                    projetosTitles
                        .map(
                            p => p.titulo
                        )
                        .join(', ');

                req.flash(
                    'error_msg',
                    `Você precisa avaliar todos os critérios dos projetos atribuídos antes de finalizar. Projetos pendentes: ${titles}.`
                );

                return res.redirect(
                    '/avaliador/dashboard'
                );
            }

            /*
             * Todas as avaliações estão completas.
             */

            avaliadorData.ativo = false;

            avaliadorData.statusAvaliacaoGeral =
                true;

            await avaliadorData.save();

            /*
             * Encerra sessão.
             */

            req.session.destroy(
                err => {

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
                        res.redirect(
                            '/avaliador/agradecimento'
                        );
                    }
                }
            );

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

                res.redirect(
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

            res.redirect(
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

    res.render(
        'avaliador/agradecimento',
        {
            layout: 'layouts/public',

            titulo:
                'Obrigado por sua participação'
        }
    );
});


// ============================================================
// ACESSO DIRETO VIA PIN / QR CODE
// ============================================================

router.get(
    '/acesso-direto/:pin',
    async (req, res) => {

        try {

            const { pin } =
                req.params;

            const avaliador =
                await Avaliador.findOne({
                    pin,
                    ativo: true
                }).populate(
                    'projetosAtribuidos'
                );

            if (!avaliador) {

                return res
                    .status(404)
                    .send(
                        'PIN inválido ou avaliador desativado.'
                    );
            }

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

            return res
                .status(500)
                .send(
                    'Erro ao acessar o sistema.'
                );
        }
    }
);


// ============================================================
// FEEDBACK
// ============================================================

router.post(
    '/feedback',
    async (req, res) => {

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
                        tipo ||
                        'Avaliador',

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

            res.redirect(
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

            res.redirect(
                '/avaliador/agradecimento'
            );
        }
    }
);


module.exports = router;

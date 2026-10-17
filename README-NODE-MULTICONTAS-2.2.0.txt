H2E CRM WHATSAPP MULTI-CONTAS — SERVIÇO NODE.JS 2.2.0

O QUE MUDA
- Diagnóstico autenticado em /api/diagnostics: verifica permissões de escrita de DATA_DIR e SESSIONS_DIR, consistência do cadastro em memória vs. accounts.json e configuração básica.
- Gravação atômica de accounts.json para reduzir risco de arquivo parcial.
- Logs detalhados em falhas da rota de criação de conta.
- A criação de conta agora volta atrás se não conseguir persistir o registro, e retorna mensagem específica.
- Mantém o patch experimental de pareamento comunitário da versão 2.1.0.

ATUALIZAÇÃO
1. Faça backup/commit dos arquivos atuais no repositório `multicontas`.
2. Extraia este ZIP e envie `server.js` e `package.json` para a raiz do repositório, substituindo os anteriores.
3. Faça commit na branch `main`; reimplante a aplicação Node.js na Hostinger.
4. Mantenha o BRIDGE_SECRET existente e igual ao guardado no WordPress. Não publique secrets no GitHub.
5. Mantenha DATA_DIR e AUTH_DIR/SESSIONS_DIR numa pasta gravável e persistente indicada/suportada pela hospedagem. Caminhos relativos a uma versão efêmera podem ser substituídos em novo deploy.
6. Teste `/health`. Para diagnóstico autenticado, o plugin H2E CRM WhatsApp 3.1.1 expõe um botão "Testar serviço" que chama `/api/diagnostics` usando o segredo salvo.
7. O diagnóstico não inclui a chave secreta nem caminhos absolutos.

ENV
BRIDGE_SECRET=<igual ao WordPress>
HOST=0.0.0.0
PORT=3000 (ou a porta da Hostinger)
DATA_DIR=<diretório persistente gravável>
AUTH_DIR=./auth_info
WORDPRESS_INBOUND_URL=https://dozeroaoabsoluto.michproducoes.com/wp-json/h2e-crm/v1/bridge-incoming
LOG_LEVEL=info

OBSERVAÇÃO DE SEGURANÇA
Baileys é uma biblioteca não oficial e o patch comunitário de pareamento é experimental; não há garantia até um teste de ponta a ponta. Não enviar spam ou mensagens não solicitadas. Faça backup das sessões antes de reimplantar.

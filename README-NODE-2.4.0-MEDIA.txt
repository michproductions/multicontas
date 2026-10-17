H2E CRM WhatsApp Node Service 2.4.0

REQUISITOS
- Node.js 20 ou superior (Node.js 20.x é a versão atualmente selecionada na implantação mostrada).
- npm e uma aplicação Express ativa na Hostinger.
- DATA_DIR e os diretórios de sessões configurados para armazenamento persistente.

ATUALIZAÇÃO
1. Extraia este ZIP.
2. No repositório/branch que a Hostinger usa para publicar, substitua server.js e package.json na raiz.
3. Confirme que package.json tem o script "start": "node server.js".
4. Faça commit e reimplante a aplicação existente na Hostinger. Não envie somente o ZIP para a raiz do GitHub.
5. Preserve as variáveis ambientais configuradas. BRIDGE_SECRET precisa ser igual ao segredo guardado no WordPress; WORDPRESS_INBOUND_URL deve continuar apontando para o endpoint do plugin.
6. Abra /health. A resposta deve incluir serviceVersion 2.4.0.

VARIÁVEIS
- BRIDGE_SECRET: segredo compartilhado com o WordPress.
- HOST: 0.0.0.0.
- PORT: use a porta indicada/configurada na aplicação Hostinger.
- DATA_DIR: diretório persistente para accounts.json, chat-store e media.
- AUTH_DIR / SESSIONS_DIR: diretório persistente das sessões autenticadas.
- WORDPRESS_INBOUND_URL: https://seu-wordpress/wp-json/h2e-crm/v1/bridge-incoming
- LOG_LEVEL: info durante diagnóstico; warn após estabilizar.

CAIXA DE MENSAGENS E ANEXOS
- A caixa de entrada chama GET /api/accounts/:id/chats e GET /api/accounts/:id/messages?jid=...
- Envio de texto: POST /api/accounts/:id/messages.
- Envio de anexos: POST /api/accounts/:id/media. A API permite imagem, áudio, vídeo e documento até 16 MB, com base64 no payload JSON.
- Mídia recebida é enfileirada para download e armazenamento. O cache usa DATA_DIR/media; metadados ficam no chat-store. O endpoint GET /api/accounts/:id/media/:messageId exige o cabeçalho x-h2e-secret.
- O WordPress faz o proxy da mídia pelo admin-ajax autenticado; o segredo do serviço não é enviado ao navegador.

LIMITAÇÕES IMPORTANTES
- Mídia recebida acima de 25 MB não é armazenada por esta versão. Mídias que o WhatsApp não disponibilizar para download ficam marcadas como indisponíveis.
- Anexos do CRM são limitados a 16 MB por causa dos limites práticos de memória/HTTP do WordPress e do serviço.
- Histórico de mídia antiga só pode ser mostrado se o WhatsApp o sincronizar e o arquivo puder ser baixado com a sessão ativa.
- A integração usa biblioteca não oficial do protocolo WhatsApp Web. Não há garantia de compatibilidade futura, e a Meta pode desconectar sessões.
- Faça backup de DATA_DIR e dos diretórios de autenticação antes de publicar novas versões. Não comite segredos ou arquivos de sessão no GitHub.

H2E CRM WHATSAPP — SERVIÇO NODE.JS MULTI-CONTAS v2.0.0

O que mudou
- Permite cadastrar várias contas WhatsApp com QR Code independente.
- Mantém estado e sessão separados por conta.
- Inclui status, QR Code, envio de texto, atraso por conta e proxy HTTP/HTTPS/SOCKS5 opcional.
- Mantém rotas antigas /api/status, /api/qr, /api/connect, /api/logout e /api/send para compatibilidade básica.

ATUALIZAÇÃO DO REPOSITÓRIO HOSTINGER/GITHUB
1. Faça backup do repositório GitHub ligado à aplicação Hostinger.
2. Extraia este ZIP no computador.
3. Substitua no diretório raiz do repositório os arquivos server.js e package.json pelos arquivos deste pacote. O .env.example é apenas um modelo; NÃO substitui as variáveis reais já cadastradas no hPanel.
4. Envie/commit as alterações para a branch main de github.com/michproductions/whatsappweb.
5. No hPanel, abra a aplicação hotpink-kangaroo-354026.hostingersite.com e use Reimplantar. Aguarde npm install e a conclusão da implantação.
6. Teste https://hotpink-kangaroo-354026.hostingersite.com/health. A resposta deve conter "ok":true e "service":"H2E CRM WhatsApp Web Bridge".
7. No WordPress, atualize o plugin pelo ZIP do H2E CRM WhatsApp 3.1.0. Não envie este ZIP de Node.js para o instalador do WordPress.

VARIÁVEIS DE AMBIENTE
- BRIDGE_SECRET: o mesmo segredo do campo "Segredo compartilhado do serviço" no WordPress.
- WORDPRESS_INBOUND_URL: URL completa do WordPress terminando em /wp-json/h2e-crm/v1/bridge-incoming.
- HOST: normalmente 0.0.0.0.
- PORT: deixe a Hostinger definir ou use o valor esperado pela plataforma.
- DATA_DIR: pasta PERSISTENTE, fora da pasta de build/versionamento, para guardar accounts.json.
- SESSIONS_DIR: opcional; padrão DATA_DIR/sessions, onde os dados de autenticação por conta ficam salvos.
- AUTH_DIR: compatibilidade de migração com a versão antiga de conta única. Se contiver arquivos da sessão antiga, o serviço tenta copiá-los para a sessão da conta principal na inicialização.

IMPORTANTE SOBRE PERSISTÊNCIA
O caminho padrão ./h2e-whatsapp-data é relativo ao diretório da aplicação e pode ser substituído numa nova implantação, dependendo de como a hospedagem gerencia builds. Antes de parear contas de produção, configure DATA_DIR para uma pasta persistente fornecida/permitida no ambiente Hostinger. Não adivinhe o caminho absoluto: confirme-o no hPanel ou com o suporte da Hostinger. Os arquivos de sessão permitem acesso à conta WhatsApp e devem ser protegidos como credenciais.

TELA DO CRM
Depois da implantação do Node.js, abra WordPress > CRM WhatsApp > Configurações e mantenha URL base e BRIDGE_SECRET. Depois abra CRM WhatsApp > Conectar WhatsApp. Clique em Adicionar conta, digite um nome e escaneie o QR Code. Repita para cada conta.

DELAY E PROXY
- Delay é intervalo aleatório em segundos aplicado antes do envio de cada mensagem daquela conta. Não garante ausência de restrições pelo WhatsApp.
- Proxy aceita URL http://, https://, socks5:// ou socks5h://. A alteração do proxy vale a partir da próxima conexão/reconexão da conta. Proxies com credenciais devem ser armazenados com segurança.
- Remover uma conta apaga a sessão local dessa conta no diretório SESSIONS_DIR e pede novo pareamento se ela for adicionada novamente.

LIMITAÇÕES E SEGURANÇA
Esta integração utiliza a biblioteca não oficial @whiskeysockets/baileys e não é certificada pela Meta. O protocolo pode mudar e a sessão pode desconectar ou sofrer restrições. Teste com uma conta secundária antes de colocar uma conta principal/comercial. O serviço foi verificado por sintaxe, mas não foi possível validar a conexão com contas reais do WhatsApp nem as configurações específicas do seu plano Hostinger a partir daqui.

# Olheiro Digital — Z Studios

Radar de prospecção de talentos musicais. Frontend single-page + API Node/Express com persistência em arquivo JSON.

## Estrutura

```
/
├── server.js                 # Express: serve o app e as APIs
├── package.json
├── public/
│   └── index.html            # Frontend (Tailwind via CDN)
├── data/
│   ├── artists.seed.json     # 42 artistas iniciais (versionado)
│   └── artists.json          # Dados em runtime (NÃO versionado)
├── railway.toml
├── .gitignore
└── README.md
```

## Rodar localmente

```bash
npm install
npm start
```

Abra http://localhost:3000

Na primeira execução, `data/artists.json` é criado a partir de `data/artists.seed.json`. Depois disso, todas as alterações (scrape de novos artistas, adição ao CRM) ficam salvas nesse arquivo.

## API

| Método | Rota                       | Descrição                                                     |
|--------|----------------------------|---------------------------------------------------------------|
| GET    | `/api/artists`             | Lista todos os artistas persistidos                           |
| POST   | `/api/scrape`              | Gera 3–6 novos artistas fictícios e **salva no banco JSON**   |
| POST   | `/api/artists/:id/crm`     | Marca um artista como adicionado ao CRM                       |
| GET    | `/health`                  | Healthcheck (usado pelo Railway)                              |

## Deploy no Railway

1. Crie um novo projeto no Railway (**New Project → Deploy from GitHub repo** ou **Empty Project → Deploy**)
2. Conecte o repositório / faça push do código
3. Railway detecta Node automaticamente e roda `npm start`
4. **IMPORTANTE — persistência entre deploys:** adicione um Volume:
   - No dashboard do serviço → aba **Variables** → **+ New Volume**
   - Mount path: `/data`
   - Depois em **Variables**, adicione `DATA_DIR=/data`
5. Redeploy. A partir daqui, todos os artistas raspados e adicionados ao CRM ficam salvos — mesmo depois de redeploys, e visíveis de qualquer computador que acessar a URL pública.

Sem o Volume, o app funciona, mas perde os dados a cada redeploy (volta ao seed de 42 artistas).

## Variáveis de ambiente

| Nome       | Default    | Descrição                                    |
|------------|------------|----------------------------------------------|
| `PORT`     | `3000`     | Porta do servidor (Railway define sozinho)   |
| `DATA_DIR` | `./data`   | Diretório onde o `artists.json` é gravado    |

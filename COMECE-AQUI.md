# Sprint Dapper Labs

O case está em `case/index.html`; use o servidor para carregar os dados e a demonstração.

```sh
node scripts/serve.cjs
```

Abra http://127.0.0.1:8766.

O código foi implementado no protótipo aberto da Dapper. A página reúne a explicação, a auditoria e uma simulação dos estados de resposta. As respostas do seletor são sintéticas e estão identificadas; os snapshots de coleção vêm do repositório original.

- `SPRINT.md`: método, fontes, escolhas e validação em inglês.
- `case/audit.json`: resultados reproduzíveis da auditoria em Python e SQL.
- `contribution.patch`: proposta de alteração aplicável ao código original, sem a página pessoal.
- `case/contribution-check.txt`: confirmação de aplicação e testes do patch.

O teste amplo teve 8 verificações aprovadas e falhou no limite de primeira pintura sob conexão/CPU restritas. Não há alegação de melhora de desempenho. A página do case e os quatro estados funcionais foram conferidos em navegador.

Ainda não publicado nem enviado à Dapper.

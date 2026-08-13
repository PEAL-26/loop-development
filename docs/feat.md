- Implementar uma funcionalidade para lista de pastas permitidas predefinidas, que estão fora do directorio do projecto

- Melhorar a integração de executar o agente em várias sessões, ou seja, nesse momento eu tenho um mono repo (mas não o convecional) que tem 3 partes (mobile, web, desktop) e em cada um deles eu posso inicializar o loop-development, e ter o loop-development geral que fica na raiz do projecto, por que nesse momento o agente só axecuta funcionalidade por funcionalidade, e se eu estiver a desenvolver em 2 projectos ao mesmo tempo, assim os arquivos de estados não são sobre-postos, como desse jeito já funciona que é iniciar em cada projecto, agora eu gostaria de ter alguma forma de ligar os projecto, referrenciando o principal e no principal referenciando os filhos ou os subprojectos iniciados ou algo parecido, isso deve ser feito meio que automático, se ao executar o loop-development ele detetar que em algum outro projecto foi iniciado o loop-development, então ele faz a ligação automática, reconhecendo o principal e os ficlhor, o principal é sempre o que está na raiz principal e os ficlhor é sempre que estão na raiz dos subdirectorios.

Ex.:
- projecto-x (pasta raiz)
-- .loop-development (main)
--- pasta-x
---- .loop-development (child)
--- pasta-z
---- .loop-development (child)

E assim eu consigo executar alguma tarefa num subprojecto, e se ele reconhece o main pelo menos ele em acesso a pasta razi também, porque se o loop-development estiver acessar uma pasta fora do seu directorio ele pede permissão, mas com essa implementação e ele reconhecer que ele faz parte do projecto todo, então não precisa mas de permissão, ele pode acessar normalmente.
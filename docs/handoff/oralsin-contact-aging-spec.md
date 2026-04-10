# Contact Aging — Especificacao para Time Oralsin

> **Data:** 2026-04-10
> **De:** Dispatch (Matheus)
> **Para:** Time Oralsin (backend)
> **Status Dispatch:** Endpoint sera criado apos confirmacao do Oralsin
> **Branch:** `feat/anti-ban-scaling`

---

## TL;DR

Precisamos que o Oralsin **pre-registre contatos novos 3 dias antes do envio** para que o WhatsApp nao detecte o padrao "contato criado + mensagem enviada no mesmo segundo". O Dispatch vai expor um endpoint `POST /api/v1/plugins/oralsin/contacts/pre-register` — o Oralsin precisa chamar esse endpoint no D-6 (6 dias antes do vencimento, 3 dias antes do envio).

---

## O Que Muda no Oralsin

### Mudanca 1: Nova Activity no DataPrepWorkflow (Stage 4.5)

**Onde:** `data_prep_workflow.py` (ou novo arquivo `contact_pre_register_activity.py`)

**Quando executa:** Diariamente, junto com o DataPrepWorkflow existente.

**Logica:**

```python
# Pseudo-codigo — adaptar para Temporal activity
class ContactPreRegisterActivity:
    """
    Busca installments com vencimento em D+3 a D+6.
    Para cada paciente SEM PatientPhoneAffinity existente,
    resolve o phone pair e chama Dispatch para pre-registrar o contato.
    """
    
    async def execute(self):
        # 1. Buscar installments com vencimento em 3-6 dias
        target_start = date.today() + timedelta(days=3)
        target_end = date.today() + timedelta(days=6)
        
        installments = await self.get_pending_installments(
            due_date_range=(target_start, target_end),
            status='PENDING',  # so parcelas nao pagas
        )
        
        # 2. Filtrar: so pacientes SEM PatientPhoneAffinity
        new_contacts = []
        for inst in installments:
            patient = inst.contact_schedule.patient
            affinity = await PatientPhoneAffinity.get_or_none(
                patient_phone=patient.phone
            )
            if affinity is not None:
                continue  # ja tem pair — contato ja existe no device
            
            # 3. Resolver phone pair (reusar PatientPhoneResolver existente)
            pair = await PatientPhoneResolver.resolve(patient.phone)
            
            new_contacts.append({
                "patient_phone": patient.phone,      # com DDI: 5543991938235
                "patient_name": patient.name,         # nome completo
                "sender_phone": pair.sender_phone,    # +5543996835100
                "sender_session": pair.session_name,  # oralsin-main-2
            })
        
        if not new_contacts:
            return  # nada a fazer
        
        # 4. Chamar Dispatch em batch
        response = await self.dispatch_client.post(
            "/api/v1/plugins/oralsin/contacts/pre-register",
            json=new_contacts,
        )
        # response: { registered: 45, skipped: 15, errors: 0 }
        
        # 5. Criar PatientPhoneAffinity para cada contato registrado
        for contact in new_contacts:
            await PatientPhoneAffinity.get_or_create(
                patient_phone=contact["patient_phone"],
                defaults={
                    "sender_phone": contact["sender_phone"],
                    "session_name": contact["sender_session"],
                    "created_by": "pre-register",
                },
            )
```

**Pontos importantes:**
- Reusar `PatientPhoneResolver` existente para resolver o phone pair
- A janela D+3 a D+6 garante 3 dias de "envelhecimento" do contato
- Batch unico por dia (nao precisa de cron separado)

---

### Mudanca 2: Chamar o Endpoint do Dispatch

**Contrato da API:**

```
POST /api/v1/plugins/oralsin/contacts/pre-register
Content-Type: application/json
X-API-Key: <DISPATCH_API_KEY>

Request Body (array de contatos):
[
  {
    "patient_phone": "5543991938235",
    "patient_name": "Joao Silva",
    "sender_phone": "+5543996835100",
    "sender_session": "oralsin-main-2"
  },
  {
    "patient_phone": "5541988887777",
    "patient_name": "Maria Santos",
    "sender_phone": "+5543996835100",
    "sender_session": "oralsin-main-2"
  }
]

Response 200:
{
  "registered": 45,
  "skipped": 15,
  "errors": 0,
  "details": [
    { "phone": "5543991938235", "status": "registered" },
    { "phone": "5541988887777", "status": "skipped", "reason": "already_exists" }
  ]
}
```

**Campos:**
| Campo | Tipo | Obrigatorio | Descricao |
|-------|------|-------------|-----------|
| `patient_phone` | string | Sim | Telefone do paciente com DDI (digits only, 10-15 chars) |
| `patient_name` | string | Sim | Nome completo do paciente (para salvar no contato do device) |
| `sender_phone` | string | Sim | Numero do sender que vai enviar (para rotear ao device correto) |
| `sender_session` | string | Nao | Nome da sessao WAHA (informativo, nao usado no pre-register) |

**Comportamento:**
- Dispatch recebe o batch, roteia cada contato ao device do `sender_phone`
- Registra o contato no Android via content provider (nome + telefone)
- **NAO envia mensagem** — apenas cria o contato
- Idempotente: se o contato ja existe, retorna `skipped`
- Salva no DB local para tracking

---

### Mudanca 3: Criar PatientPhoneAffinity no Pre-Register

**Onde:** Na activity acima (passo 5), apos confirmacao do Dispatch.

**Por que:** Garante que o **mesmo phone pair que registrou o contato** sera o que envia a mensagem. Se o pair mudar, o contato nao existira no device novo e o aging se perde.

**Logica:**
```python
# Criar affinity so se nao existe (idempotente)
await PatientPhoneAffinity.get_or_create(
    patient_phone=contact["patient_phone"],
    defaults={
        "sender_phone": contact["sender_phone"],
        "session_name": contact["sender_session"],
        "created_by": "pre-register",  # diferenciar de "first-send"
    },
)
```

**Nota:** Se o `PatientPhoneAffinity` ja existe (de um envio anterior), nao sobrescrever — o pair ja esta definido.

---

## Volume Esperado

| Metrica | Valor |
|---------|-------|
| Schedules/dia (4 clinicas) | ~150 |
| % contatos novos | ~30-40% |
| Pre-registers/dia | ~45-60 |
| Por phone pair (8 pairs) | ~6-8/dia |
| Payload maximo | ~60 items por batch |

**Performance:** O endpoint Dispatch processa ~5 contatos/segundo (ADB content provider insert). Um batch de 60 leva ~12 segundos.

---

## Timeline e Coordenacao

```
1. Oralsin confirma: "vamos implementar" + estima prazo
2. Dispatch cria o endpoint POST /contacts/pre-register (1-2 dias)
3. Oralsin implementa a Activity no DataPrepWorkflow (1-2 dias)
4. Teste integrado: Oralsin envia batch → Dispatch registra → verificar no device
5. Deploy coordenado
```

**O Dispatch ainda NAO tem o endpoint.** Sera criado apos confirmacao do Oralsin. Prazo Dispatch: 1-2 dias apos go-ahead.

---

## Trade-offs Discutidos

| Opcao | Aging | Desperdicio | Recomendacao |
|-------|-------|-------------|--------------|
| D-6 (3 dias antes) | 3 dias | ~10% (paciente paga entre D-6 e D-3) | **Recomendado** |
| D-4 (1 dia antes) | 1 dia | ~3% | Alternativa se 3 dias for muito |

Desperdicio = contato registrado mas paciente pagou antes do envio. Impacto zero (contato extra no device, sem efeito colateral).

---

## Perguntas para o Oralsin

1. O `DataPrepWorkflow` ja roda diariamente? Em que horario?
2. O `PatientPhoneResolver` pode ser chamado fora do `NotificationSendWorkflow`?
3. Preferem D-6 (3 dias) ou D-4 (1 dia) de aging?
4. Existe algum campo no modelo que indique "contato ja pre-registrado" ou precisamos criar?

<script setup lang="ts">
    import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
    import { Plus, Search, Mail, CalendarDays, Sparkles, Upload, ChevronDown, ChevronUp, CheckCircle2, AlertCircle, FileSpreadsheet, ArrowUp, ShieldCheck, Save, Eye, X, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-vue-next';
    import { Button } from './ui/button';
    import { Card } from './ui/card';
    import { Input } from './ui/input';
    import { Textarea } from './ui/textarea';
    import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
    import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
    import AppSelect from './ui/AppSelect.vue';
    import HtmlEditor from './HtmlEditor.vue';
    import AgentDialog from './AgentDialog.vue';
    import { useFeedback, notify } from '@/lib/notifications';
    import { api, ApiError, idPath, type Kind, type Payload, type Message, type Template, type Task } from '@/lib/api';
    import type { AgentAttachment } from '@/lib/agent';
    import { fieldsIn, mappedRows, mergeIssues, renderFields, recommendedEmailColumn, type DataRow } from '@/lib/mailMerge';
    const tokenLabel = (field: string) => `{{${field}}}`;
    const eventLabels = computed<Record<string, string>>(() => ({
        requiredAttendees: props.t('必需参会者', 'Required attendees'),
        optionalAttendees: props.t('可选参会者', 'Optional attendees'),
        start: props.t('开始 · 北京时间', 'Start · Beijing time'),
        end: props.t('结束 · 北京时间', 'End · Beijing time'),
        location: props.t('地点', 'Location'),
    }));
    const props = defineProps<{
        templates: Template[];
        tasks: Task[];
        t: (zh: string, en: string) => string;
        dark: boolean;
        visible: boolean;
        locked: boolean;
    }>();
    const emit = defineEmits<{
        review: [Task];
        saved: [];
        settings: [];
        expired: [];
        busy: [boolean];
        template: [Kind, Payload];
    }>();
    interface Proposal {
        message: string;
        kind: Kind;
        payload: Payload;
        mapping?: Record<string, string>;
    }
    interface Draft {
        id: string;
        title: string;
        kind: Kind;
        payload: Payload;
        templateId: string;
        rows: DataRow[];
        columns: string[];
        fileName: string;
        recipientColumn: string;
        manualTo: string;
        mapping: Record<string, string>;
        conversation: Message[];
        attachments: AgentAttachment[];
        message: string;
        proposal?: Proposal;
        suggestionContext?: Pick<Payload, 'subject' | 'html'>;
        suggestionSnapshot?: string;
        saved?: Task;
        savedSnapshot?: string;
        mergeOpen: boolean;
        sample: number;
    }
    function blank(kind: Kind): Draft {
        return {
            id: crypto.randomUUID(),
            title: kind === 'email' ? props.t('未命名邮件', 'Untitled email') : props.t('未命名日程', 'Untitled event'),
            kind,
            payload:
                kind === 'email'
                    ? { to: '', cc: '', bcc: '', subject: '', html: '' }
                    : {
                          subject: '',
                          html: '',
                          start: '',
                          end: '',
                          requiredAttendees: '',
                          optionalAttendees: '',
                          location: '',
                      },
            templateId: 'none',
            rows: [],
            columns: [],
            fileName: '',
            recipientColumn: '',
            manualTo: '',
            mapping: {},
            conversation: [],
            attachments: [],
            message: '',
            mergeOpen: false,
            sample: 0,
        };
    }
    const drafts = ref<Draft[]>([blank('email')]);
    const activeId = ref(drafts.value[0]!.id);
    const draft = computed(() => drafts.value.find((item) => item.id === activeId.value)!);
    const search = ref(''),
        activity = ref(''),
        error = ref(''),
        success = ref(''),
        agentError = ref('');
    const agentOpen = ref(false),
        ccOpen = ref(false),
        bccOpen = ref(false),
        applyTemplateOpen = ref(false),
        clearOpen = ref(false);
    const busy = computed(() => !!activity.value || props.locked);
    useFeedback({
        error,
        success,
        pending: () =>
            activity.value && activity.value !== 'agent'
                ? props.t(
                      (
                          {
                              import: '正在导入名单…',
                              save: '正在保存草稿…',
                              agent: 'Agent 正在起草…',
                              load: '正在读取草稿…',
                          } as Record<string, string>
                      )[activity.value] || '正在处理…',
                      'Working on your draft…',
                  )
                : '',
    });
    useFeedback({
        error: agentError,
        errorAction: () => ({
            label: props.t('检查 AI 配置', 'Check AI settings'),
            run: () => {
                agentOpen.value = false;
                emit('settings');
            },
        }),
    });
    const fileInput = ref<HTMLInputElement>();
    const dataPage = ref(0),
        problemOnly = ref(false),
        dataOpen = ref(false),
        mappingOpen = ref(false);
    const visibleDrafts = computed(() => drafts.value.filter((item) => item.title.toLowerCase().includes(search.value.toLowerCase())));
    const templateOptions = computed(() => [
        {
            value: 'none',
            label: props.t('不使用模板 · 自由写作', 'No template · free writing'),
        },
        ...props.templates
            .filter((item) => item.kind === draft.value.kind)
            .map((item) => ({
                value: item.id,
                label: `${item.name} · v${item.version}`,
            })),
    ]);
    const issues = computed(() => mergeIssues(draft.value.kind, draft.value.payload, draft.value.rows, draft.value.mapping));
    const placeholders = computed(() => fieldsIn(draft.value.payload));
    const insertFields = computed(() => [...new Set([...draft.value.columns, ...placeholders.value])]);
    const suggestion = computed(() => recommendedEmailColumn(draft.value.columns));
    const columnOptions = computed(() => draft.value.columns.map((column) => ({ value: column, label: column })));
    const pageRows = computed(() => draft.value.rows.map((row, index) => ({ row, index })).filter((entry) => !problemOnly.value || issues.value.some((issue) => issue.row === entry.index + 1)));
    const pageCount = computed(() => Math.max(1, Math.ceil(pageRows.value.length / 5)));
    const displayedRows = computed(() => pageRows.value.slice(dataPage.value * 5, dataPage.value * 5 + 5));
    const sampleOptions = computed(() =>
        draft.value.rows.map((row, index) => ({
            value: String(index),
            label: `${props.t('第', 'Row')} ${index + 1} · ${String(row[draft.value.recipientColumn] || Object.values(row)[0] || '')}`,
        })),
    );
    const selectedSample = computed({
        get: () => String(draft.value.sample),
        set: (value) => (draft.value.sample = Number(value)),
    });
    const previewHtml = computed(() => renderFields(draft.value.payload.html, draft.value.rows[draft.value.sample] || {}, draft.value.mapping, true));
    const previewSubject = computed(() => renderFields(draft.value.payload.subject, draft.value.rows[draft.value.sample] || {}, draft.value.mapping));
    const snapshot = () =>
        JSON.stringify({
            kind: draft.value.kind,
            payload: draft.value.payload,
            rows: draft.value.rows,
            mapping: draft.value.mapping,
            templateId: draft.value.templateId,
        });
    const savedCurrent = computed(() => draft.value.savedSnapshot === snapshot());
    const selectedTemplate = ref('none');
    watch(
        () => props.tasks,
        (tasks) => {
            for (const item of drafts.value) {
                const updated = tasks.find((task) => task.id === item.saved?.id);
                if (updated && item.saved) item.saved.status = updated.status;
            }
        },
    );
    watch(pageCount, (count) => (dataPage.value = Math.min(dataPage.value, count - 1)));
    watch(placeholders, (fields) => {
        for (const field of fields) if (!draft.value.mapping[field] && draft.value.columns.includes(field)) draft.value.mapping[field] = field;
    });
    watch(activity, (value) => emit('busy', !!value));
    watch(
        () => props.visible,
        (visible) => {
            if (!visible) agentOpen.value = false;
        },
    );
    watch(activeId, () => {
        error.value = '';
        success.value = '';
        agentError.value = '';
        dataPage.value = 0;
        problemOnly.value = false;
        dataOpen.value = false;
        mappingOpen.value = false;
        selectedTemplate.value = draft.value.templateId;
        ccOpen.value = !!draft.value.payload.cc;
        bccOpen.value = !!draft.value.payload.bcc;
    });
    onMounted(() => {
        document.addEventListener('keydown', shortcut);
    });
    async function run(action: string, operation: () => Promise<void>, agent = false) {
        if (busy.value) return;
        activity.value = action;
        error.value = '';
        success.value = '';
        if (agent) agentError.value = '';
        try {
            await operation();
        } catch (cause) {
            const description = cause instanceof Error ? cause.message : String(cause);
            if (agent) agentError.value = description;
            else error.value = description;
            if (cause instanceof ApiError && cause.status === 401) emit('expired');
        } finally {
            activity.value = '';
        }
    }
    function addDraft(kind: Kind = 'email', startAgent = true) {
        if (busy.value) return;
        const created = blank(kind);
        drafts.value.push(created);
        activeId.value = created.id;
        if (kind === 'email' && startAgent) agentOpen.value = true;
    }
    function changeKind(kind: string | number) {
        if (kind !== draft.value.kind) addDraft(kind as Kind, kind === 'email');
    }
    function requestTemplate() {
        if (selectedTemplate.value === 'none') {
            draft.value.templateId = 'none';
            return;
        }
        if (!draft.value.payload.subject && !draft.value.payload.html) applyTemplate();
        else applyTemplateOpen.value = true;
    }
    function applyTemplate() {
        const template = props.templates.find((item) => item.id === selectedTemplate.value);
        if (!template) return;
        draft.value.templateId = template.id;
        if (['未命名邮件', 'Untitled email', '未命名日程', 'Untitled event'].includes(draft.value.title)) draft.value.title = template.name;
        draft.value.payload.subject = template.subject;
        draft.value.payload.html = template.html;
        draft.value.proposal = undefined;
        applyTemplateOpen.value = false;
    }
    async function importFile(event: Event) {
        const input = event.target as HTMLInputElement,
            file = input.files?.[0];
        if (!file) return;
        await run('import', async () => {
            if (file.size > 5 * 1024 * 1024) throw Error(props.t('文件不能超过 5 MB。', 'File must not exceed 5 MB.'));
            const form = new FormData();
            form.append('file', file);
            const data = await api<{
                columns: string[];
                rows: DataRow[];
                count: number;
            }>('/import', 'POST', form);
            if (!data.rows.length) throw Error(props.t('名单没有可用数据行。', 'The file contains no data rows.'));
            const target = draft.value;
            const recipientKey = target.kind === 'email' ? 'to' : 'requiredAttendees';
            if (!target.rows.length) target.manualTo = target.payload[recipientKey] || '';
            target.rows = data.rows;
            target.columns = data.columns;
            target.fileName = file.name;
            target.recipientColumn = '';
            target.mapping = {};
            target.sample = 0;
            target.mergeOpen = true;
            target.payload[recipientKey] = '';
            target.proposal = undefined;
            dataPage.value = 0;
            dataOpen.value = false;
            mappingOpen.value = fieldsIn(target.payload).some((field) => !target.mapping[field]);
            for (const field of fieldsIn(target.payload)) if (target.columns.includes(field)) target.mapping[field] = field;
            success.value = props.t('名单已导入。请先确认收件人列，再插入字段。', 'Imported. Confirm the recipient column before inserting fields.');
        });
        input.value = '';
    }
    function selectRecipient(column: string) {
        draft.value.recipientColumn = column;
        draft.value.payload[draft.value.kind === 'email' ? 'to' : 'requiredAttendees'] = `{{${column}}}`;
        draft.value.mapping[column] = column;
        success.value = props.t(`已确认邮箱列「${column}」。可插入字段并检查整批个性化内容。`, `Confirmed email column “${column}”. Insert fields and review the personalized batch.`);
        error.value = '';
    }
    function clearData() {
        const target = draft.value;
        target.rows = [];
        target.columns = [];
        target.fileName = '';
        target.recipientColumn = '';
        target.mapping = {};
        target.payload[target.kind === 'email' ? 'to' : 'requiredAttendees'] = target.manualTo;
        target.sample = 0;
        target.proposal = undefined;
        success.value = props.t('已移除名单，恢复为单次任务。', 'List removed. Restored a single task.');
        error.value = '';
        clearOpen.value = false;
    }
    async function save(review = false) {
        await run('save', async () => {
            if (draft.value.rows.length && !draft.value.recipientColumn) throw Error(props.t('请先确认名单的收件人列。', 'Confirm the recipient column first.'));
            if (issues.value.length) {
                draft.value.mergeOpen = !!draft.value.rows.length;
                throw Error(props.t(`请修正 ${issues.value.length} 处问题后再保存。`, `Fix ${issues.value.length} issues before saving.`));
            }
            const target = draft.value;
            if (!savedCurrent.value || !target.saved || target.saved.status !== 'draft') {
                const saved = await api<Task>('/tasks', 'POST', {
                    kind: target.kind,
                    payload: target.payload,
                    rows: target.rows.length ? mappedRows(target.rows, target.mapping) : undefined,
                    templateId: target.templateId === 'none' ? undefined : target.templateId,
                    conversation: target.conversation.slice(-50),
                });
                target.saved = saved;
                target.savedSnapshot = snapshot();
                target.saved = await api<Task>('/tasks/' + idPath(saved.id));
                emit('saved');
            }
            if (review && target.saved) {
                target.saved = await api<Task>('/tasks/' + idPath(target.saved.id));
                emit('review', target.saved);
            } else success.value = props.t('草稿已保存到服务器，尚未执行。', 'Draft saved to the server. Not executed.');
        });
    }
    let agentController: AbortController | undefined;
    async function ask(instruction: string) {
        if (!instruction.trim() || busy.value) return;
        agentOpen.value = true;
        await run(
            'agent',
            async () => {
                const target = draft.value;
                const baseline = snapshot();
                const payload = target.suggestionSnapshot === baseline ? { ...target.payload, ...target.suggestionContext } : target.payload;
                const conversation = target.conversation.filter(entry => entry.status !== 'pending' && entry.status !== 'error' && entry.status !== 'cancelled').slice(-50).map(({ role, content }) => ({ role, content }));
                target.conversation.push({ role: 'user', content: instruction, attachments: target.attachments.map(({ name, size }) => ({ name, size })) }, { role: 'assistant', content: '', status: 'pending', stages: [], thinking: '' });
                const turn = target.conversation[target.conversation.length - 1]!;
                target.message = '';
                agentController = new AbortController();
                target.proposal = undefined;
                try {
                  const proposal = await api<Proposal>('/agent', 'POST', {
                    message: instruction,
                    conversation,
                    attachments: target.attachments,
                    kind: target.kind,
                    payload,
                    columns: target.columns,
                    sampleRows: target.rows.slice(0, 2).map((row) => Object.fromEntries(Object.keys(row).map((key) => [key, '[REDACTED]']))),
                    templateId: target.templateId === 'none' ? undefined : target.templateId,
                  }, { signal: agentController.signal, onProgress: event => {
                    if (event.type === 'thinking' && event.text) turn.thinking = (turn.thinking || '') + event.text.slice(0, Math.max(0, 20000 - (turn.thinking?.length || 0)));
                    else if (event.stage && !turn.stages!.includes(event.stage)) turn.stages!.push(event.stage);
                  } });
                if (proposal.kind !== target.kind || typeof proposal.payload?.subject !== 'string' || typeof proposal.payload?.html !== 'string') throw Error(props.t('AI 返回的草稿类型或格式不匹配，未应用任何更改。', 'AI draft type or format does not match. No changes applied.'));
                target.proposal = proposal;
                target.suggestionContext = { subject: proposal.payload.subject, html: proposal.payload.html };
                target.suggestionSnapshot = baseline;
                turn.status = 'complete';
                turn.content = proposal.message;
                } catch (error) {
                  turn.status = agentController.signal.aborted ? 'cancelled' : 'error';
                  turn.content = turn.status === 'cancelled' ? props.t('已停止生成，当前草稿未改变。', 'Generation stopped. Your draft is unchanged.') : error instanceof Error ? error.message : String(error);
                  if (turn.status !== 'cancelled') throw error;
                } finally { agentController = undefined; }
            },
            true,
        );
    }
    function applyProposal() {
        const target = draft.value,
            proposal = target.proposal;
        if (!proposal) return;
        target.payload.subject = proposal.payload.subject;
        target.payload.html = proposal.payload.html;
        if (['未命名邮件', 'Untitled email', '未命名日程', 'Untitled event'].includes(target.title)) target.title = proposal.payload.subject || target.title;
        const recipientFields = fieldsIn({
            subject: '',
            html: '',
            ...Object.fromEntries((target.kind === 'email' ? ['to', 'cc', 'bcc'] : ['requiredAttendees', 'optionalAttendees']).map((field) => [field, target.payload[field] || ''])),
        });
        for (const [field, column] of Object.entries(proposal.mapping || {})) if (target.columns.includes(column) && !recipientFields.includes(field)) target.mapping[field] = column;
        target.templateId = 'none';
        selectedTemplate.value = 'none';
        target.proposal = undefined;
        agentOpen.value = false;
        success.value = props.t('主题与正文已应用。收件人未改变，请检查后审核。', 'Subject and body applied. Recipients unchanged. Review before execution.');
    }
    function quickAction(action: string) {
        if (action === 'check') {
            draft.value.mergeOpen = true;
            if (issues.value.length) notify.warning(props.t(`发现 ${issues.value.length} 处问题，请检查正文和名单。`, `${issues.value.length} issues found. Check content and data.`));
            else notify.success(props.t('整批字段与收件人校验通过；执行前仍需人工审核。', 'All rows and recipients validated. Human review is still required.'));
        } else agentOpen.value = true;
    }
    async function reviewSaved(task: Task) {
        await run('load', async () => emit('review', await api<Task>('/tasks/' + idPath(task.id))));
    }
    function shortcut(event: KeyboardEvent) {
        if (props.visible && !busy.value && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            agentOpen.value = true;
        }
    }
    onUnmounted(() => {
        agentController?.abort();
        document.removeEventListener('keydown', shortcut);
        emit('busy', false);
    });
</script>
<template>
    <div class="desk-workspace">
        <aside class="task-space">
            <div class="row between">
                <h2>{{ t('任务空间', 'Task space') }}</h2>
                <Button variant="ghost" size="icon-sm" :aria-label="t('新建草稿', 'New draft')" :disabled="busy" @click="addDraft()"><Plus /></Button>
            </div>
            <div class="search-field"><Search :size="15" /><Input v-model="search" :placeholder="t('搜索草稿', 'Search drafts')" :aria-label="t('搜索草稿', 'Search drafts')" /></div>
            <div class="task-list">
                <p class="section-label">{{ t('当前工作草稿', 'Working drafts') }} · {{ drafts.length }}</p>
                <Button v-for="item in visibleDrafts" :key="item.id" variant="ghost" class="task-entry" :class="{ selected: item.id === activeId }" :disabled="busy" @click="activeId = item.id"
                    ><span class="row between"
                        ><strong>{{ item.title }}</strong
                        ><Mail v-if="item.kind === 'email'" :size="14" /><CalendarDays v-else :size="14" /></span
                    ><span class="muted text-xs">{{ item.payload.subject || t('等待起草', 'Ready to draft') }}</span
                    ><span class="task-state"
                        ><span class="status-dot"></span>{{ item.saved ? t('已保存', 'Saved') : t('编辑中', 'Editing') }}<span>{{ item.rows.length ? `${item.rows.length} ${t('行名单', 'rows')}` : t('单次任务', 'Single task') }}</span></span
                    ></Button
                >
                <div v-if="!visibleDrafts.length" class="empty">
                    {{ t('没有匹配的草稿', 'No matching drafts') }}
                </div>
                <p v-if="tasks.some((task) => task.status === 'draft')" class="section-label">
                    {{ t('服务器草稿', 'Saved drafts') }}
                </p>
                <Button v-for="task in tasks.filter((task) => task.status === 'draft').slice(0, 12)" :key="task.id" variant="ghost" class="task-entry" :disabled="busy" @click="reviewSaved(task)"
                    ><strong>{{ task.summary }}</strong
                    ><span class="muted text-xs">{{ t('已保存 · 点击审核', 'Saved · click to review') }} · {{ task.total }}</span></Button
                >
            </div>
            <p class="task-space-note"><ShieldCheck :size="14" />{{ t('编辑状态保留至本次会话结束；保存后进入服务器草稿。', 'Edits last for this session. Save to keep a server draft.') }}</p>
        </aside>
        <section class="compose-workspace">
            <div class="mobile-draft-switch">
                <AppSelect v-model="activeId" :disabled="busy" :options="drafts.map((item) => ({ value: item.id, label: item.title }))" :aria-label="t('切换草稿', 'Switch draft')" /><Button variant="outline" size="icon" :disabled="busy" :aria-label="t('新建草稿', 'New draft')" @click="addDraft()"><Plus /></Button>
            </div>
            <div class="compose-heading">
                <div>
                    <Input v-model="draft.title" class="draft-title" :aria-label="t('草稿名称', 'Draft name')" :disabled="busy" />
                </div>
                <Tabs :model-value="draft.kind" @update:model-value="changeKind"
                    ><TabsList
                        ><TabsTrigger value="email" :disabled="busy">{{ t('邮件', 'Email') }}</TabsTrigger
                        ><TabsTrigger value="event" :disabled="busy">{{ t('日程', 'Event') }}</TabsTrigger></TabsList
                    ></Tabs
                >
            </div>

            <Card class="merge-panel"
                ><div class="merge-summary">
                    <Button variant="ghost" class="merge-expand" :aria-expanded="draft.mergeOpen" @click="draft.mergeOpen = !draft.mergeOpen"
                        ><FileSpreadsheet :size="18" /><span>
                            <ChevronDown v-if="draft.mergeOpen" :size="15" /><ChevronRight v-else :size="15" /><strong>{{ draft.kind === 'email' ? t('邮件合并', 'Mail merge') : t('批量日程', 'Batch events') }}</strong></span
                        ></Button
                    ><span
                        v-if="draft.rows.length"
                        class="badge"
                        :class="{
                            'badge-warning': issues.length || !draft.recipientColumn,
                        }"
                        >{{ issues.length || !draft.recipientColumn ? t('待检查', 'Needs review') : t('校验通过', 'Validated') }}</span
                    ><Button variant="outline" size="sm" :disabled="busy" @click="fileInput?.click()"><Upload />{{ t(draft.rows.length ? '替换名单' : '导入名单', draft.rows.length ? 'Replace list' : 'Import list') }}</Button
                    ><Button v-if="draft.rows.length" variant="ghost" size="icon-sm" :disabled="busy" :aria-label="t('清除名单', 'Clear list')" @click="clearOpen = true"><X /></Button><input ref="fileInput" type="file" accept=".csv,.xls,.xlsx" class="sr-only" tabindex="-1" @change="importFile" />
                </div>
                <div v-if="draft.mergeOpen" class="merge-body">
                    <p v-if="!draft.rows.length" class="muted text-sm">
                        {{ t('支持 CSV / Excel，最多 5 MB、1000 行。未导入时为单次任务。', 'CSV / Excel, up to 5 MB and 1,000 rows. No list means a single task.') }}
                    </p>
                    <template v-else
                        ><ol class="merge-steps">
                            <li class="done"><CheckCircle2 :size="13" />{{ t('导入名单', 'Import list') }}</li>
                            <li :class="{ done: draft.recipientColumn }">
                                {{ t('确认收件人', 'Confirm recipients') }}
                            </li>
                            <li>{{ t('插入字段与校验', 'Insert fields & validate') }}</li>
                        </ol>
                        <div class="recipient-mapping">
                            <label class="field"
                                ><span>{{ t('收件人列（必须确认）', 'Recipient column (confirm first)') }}</span
                                ><AppSelect :model-value="draft.recipientColumn || undefined" :options="columnOptions" :placeholder="t('请选择邮箱列', 'Select email column')" :disabled="busy" @update:model-value="selectRecipient($event!)" /></label
                            ><Button v-if="!draft.recipientColumn && suggestion" variant="secondary" size="sm" @click="selectRecipient(suggestion)">{{ t('使用识别列', 'Use detected column') }}: {{ suggestion }}</Button>
                        </div>
                        <div class="merge-detail-toggles">
                            <Button variant="outline" size="sm" :aria-expanded="dataOpen" @click="dataOpen = !dataOpen"><FileSpreadsheet />{{ t(dataOpen ? '收起名单' : '查看 / 编辑名单', dataOpen ? 'Hide data' : 'View / edit list') }}</Button
                            ><Button v-if="placeholders.length" variant="ghost" size="sm" :aria-expanded="mappingOpen" @click="mappingOpen = !mappingOpen">{{ t('字段映射', 'Field mapping') }} · {{ placeholders.length }}</Button>
                        </div>
                        <div v-if="placeholders.length && mappingOpen" class="mapping-grid">
                            <label v-for="field in placeholders" :key="field" class="field"
                                ><span>{{ tokenLabel(field) }}</span
                                ><AppSelect v-model="draft.mapping[field]" :options="columnOptions" :placeholder="t('映射到名单列', 'Map to a column')" :disabled="busy || field === draft.recipientColumn"
                            /></label>
                        </div>
                        <div v-if="issues.length" class="merge-validation">
                            <AlertCircle :size="15"/><span>{{ issues.length }} {{ t('项校验详情', 'validation details') }}</span
                            ><Button
                                v-for="(issue, issueIndex) in issues.slice(0, 3)"
                                :key="issueIndex"
                                size="xs"
                                variant="ghost"
                                @click="
                                    problemOnly = true;
                                    dataOpen = true;
                                    dataPage = 0;
                                "
                                >{{ issue.row ? `${t('第', 'Row')} ${issue.row} · ` : '' }}{{ issue.field }}: {{ issue.message }}</Button
                            >
                        </div>
                        <div v-if="dataOpen" class="merge-table-scroll">
                            <table class="data-table">
                                <caption class="sr-only">
                                    {{
                                        t('邮件合并名单', 'Mail merge list')
                                    }}
                                </caption>
                                <thead>
                                    <tr>
                                        <th scope="col">{{ t('行', 'Row') }}</th>
                                        <th v-for="column in draft.columns" :key="column" scope="col">
                                            {{ column }}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr
                                        v-for="entry in displayedRows"
                                        :key="entry.index"
                                        :class="{
                                            'row-problem': issues.some((issue) => issue.row === entry.index + 1),
                                        }">
                                        <th scope="row">{{ entry.index + 1 }}</th>
                                        <td v-for="column in draft.columns" :key="column">
                                            <Input :model-value="String(entry.row[column] ?? '')" :aria-label="`${entry.index + 1} · ${column}`" :disabled="busy" @update:model-value="entry.row[column] = $event" />
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div v-if="dataOpen" class="row between merge-pagination">
                            <Button
                                variant="ghost"
                                size="sm"
                                :class="{ 'text-primary': problemOnly }"
                                @click="
                                    problemOnly = !problemOnly;
                                    dataPage = 0;
                                "
                                >{{ t(problemOnly ? '显示全部' : '只看问题行', problemOnly ? 'Show all' : 'Problem rows only') }}</Button
                            >
                            <div class="row">
                                <Button variant="outline" size="icon-sm" :disabled="dataPage === 0" :aria-label="t('上一页', 'Previous page')" @click="dataPage--"><ChevronLeft /></Button><span class="muted text-xs">{{ dataPage + 1 }} / {{ pageCount }}</span
                                ><Button variant="outline" size="icon-sm" :disabled="dataPage + 1 >= pageCount" :aria-label="t('下一页', 'Next page')" @click="dataPage++"><ChevronRight /></Button>
                            </div>
                        </div>
                        <label class="field"
                            ><span>{{ t('个性化预览样本', 'Personalized preview sample') }}</span
                            ><AppSelect v-model="selectedSample" :options="sampleOptions" /></label
                    ></template>
                </div>
            </Card>
            <Card class="compose-card"
                ><div class="compose-card-header">
                    <span class="icon-label"
                        ><Mail v-if="draft.kind === 'email'" :size="17" /><CalendarDays v-else :size="17" /><strong>{{ t(draft.kind === 'email' ? '邮件编辑器' : '日程编辑器', draft.kind === 'email' ? 'Email editor' : 'Calendar editor') }}</strong></span
                    >
                    <div class="template-picker">
                        <AppSelect v-model="selectedTemplate" :disabled="busy" :options="templateOptions" :aria-label="t('选择模板', 'Choose template')" @update:model-value="$event === 'none' && requestTemplate()" /><Button variant="ghost" size="sm" :disabled="busy || selectedTemplate === 'none'" @click="requestTemplate">{{ t('应用', 'Apply') }}</Button>
                    </div>
                </div>
                <fieldset :disabled="busy" class="compose-fields">
                    <template v-if="draft.kind === 'email'"
                        ><div class="compose-field"><label for="compose-to">To</label><Input id="compose-to" v-model="draft.payload.to" :readonly="!!draft.rows.length" :placeholder="t(draft.rows.length ? '请先确认收件人列' : '多个邮箱用分号分隔', draft.rows.length ? 'Confirm recipient column' : 'Separate emails with semicolons')" /><Button variant="ghost" size="xs" @click="ccOpen = !ccOpen">CC</Button><Button variant="ghost" size="xs" @click="bccOpen = !bccOpen">BCC</Button></div>
                        <div v-if="ccOpen || draft.payload.cc" class="compose-field"><label for="compose-cc">CC</label><Input id="compose-cc" v-model="draft.payload.cc" /></div>
                        <div v-if="bccOpen || draft.payload.bcc" class="compose-field"><label for="compose-bcc">BCC</label><Input id="compose-bcc" v-model="draft.payload.bcc" /></div
                    ></template>
                    <div v-else class="event-fields">
                        <label v-for="field in ['requiredAttendees', 'optionalAttendees']" :key="field" class="event-field"
                            ><span>{{ eventLabels[field] }}</span
                            ><Input v-model="draft.payload[field]" :aria-label="eventLabels[field]" :readonly="field === 'requiredAttendees' && !!draft.rows.length" type="text"
                        /></label>
                        <div class="event-field event-range">
                            <span>{{ t('开始时间', 'Start') }}</span
                            ><Input v-model="draft.payload.start" :aria-label="eventLabels.start" type="datetime-local" /><span>{{ t('结束时间', 'End') }}</span
                            ><Input v-model="draft.payload.end" :aria-label="eventLabels.end" type="datetime-local" />
                        </div>
                        <label class="event-field"
                            ><span>{{ eventLabels.location }}</span
                            ><Input v-model="draft.payload.location" :aria-label="eventLabels.location" type="text"
                        /></label>
                    </div>
                    <div class="compose-field">
                        <label for="compose-subject">{{ t('主题', 'Subject') }}</label
                        ><Input id="compose-subject" v-model="draft.payload.subject" :placeholder="t('给草稿一个清晰的主题', 'Give this draft a clear subject')" />
                    </div>
                </fieldset>
                <HtmlEditor v-for="editorDraft in [draft]" :key="editorDraft.id" v-model="editorDraft.payload.html" :t="t" :dark="dark" :disabled="busy" :fields="insertFields" :preview-html="previewHtml" :preview-subject="previewSubject" @agent="agentOpen = true" />
                <div class="editor-status">
                    <span>{{ t('保存后可在历史中恢复', 'Saved drafts are available in history') }}</span
                    ><span>{{ savedCurrent ? t('已保存', 'Saved') : t('有未保存编辑', 'Unsaved edits') }}</span>
                </div>
            </Card>
            <div class="compose-actions">
                <Button variant="outline" :disabled="busy" @click="save()"><Save />{{ t('保存草稿', 'Save draft') }}</Button>
                <div class="row">
                    <Button variant="ghost" :disabled="busy" @click="emit('template', draft.kind, { ...draft.payload })">{{ t('保存为模板', 'Save as template') }}</Button
                    ><Button :disabled="busy" @click="save(true)"><Eye />{{ t('审核并确认', 'Review & confirm') }}</Button>
                </div>
            </div>
            <!-- <p class="execution-note"><ShieldCheck :size="14" />{{ t('保存与起草不会发送邮件。执行前需另行确认整批内容。', 'Saving and drafting never send messages. Execution requires separate batch review.') }}</p> -->
            <div class="agent-launch-anchor">
                <Button variant="secondary" class="agent-launch" :disabled="busy" @click="agentOpen = true"
                    ><span class="agent-emblem"><Sparkles /></span
                    ><span
                        ><strong>{{ t('与 OmniMail Agent 一起起草或改写', 'Draft or revise with OmniMail Agent') }}</strong
                        ><small>{{ t('描述目标、组织内容、检查字段', 'Describe goals, organize content, check fields') }}</small></span
                    ><kbd>Command / Ctrl K</kbd></Button
                >
            </div>
        </section>
        <aside class="agent-sidebar">
            <div class="agent-heading">
                <span class="agent-emblem"><Sparkles :size="22" /></span>
                <div>
                    <h2>OmniMail Agent</h2>
                    <p>{{ t('你的邮件协作搭档', 'Your drafting partner') }}</p>
                </div>
            </div>
            <div class="agent-context">
                <strong>{{ draft.title }}</strong
                ><span
                    >{{ draft.kind === 'email' ? t('邮件草稿', 'Email draft') : t('日程草稿', 'Event draft') }}
                    ·
                    {{ draft.rows.length ? `${draft.rows.length} ${t('行名单', 'rows')}` : t('单次任务', 'Single task') }}</span
                ><span>{{ placeholders.length }} {{ t('个动态字段', 'dynamic fields') }} · {{ t('执行需人工确认', 'Human approval required') }}</span>
            </div>
            <div class="agent-chat">
                <!-- <div v-if="!draft.conversation.length" class="agent-message">
                    {{ t('从空白开始也没关系。告诉我你的目的，我会准备一版建议供你审核。', 'Starting from scratch is fine. Describe your goal for a draft you can review.') }}
                </div> -->
                <div v-for="(entry, index) in draft.conversation" :key="index" class="agent-message" :class="{ user: entry.role === 'user' }">
                    <small>{{ entry.role === 'user' ? t('你', 'You') : 'Agent' }}</small>
                    <p>{{ entry.content }}</p>
                </div>
            </div>
            <div class="agent-quick-actions">
                <Button variant="outline" size="xs" :disabled="busy" @click="quickAction('draft')">{{ t('帮我起草', 'Draft with me') }}</Button
                ><Button variant="outline" size="xs" :disabled="busy" @click="quickAction('check')">{{ t('检查合并', 'Check merge') }}</Button>
            </div>
            <Button variant="secondary" :disabled="busy" @click="agentOpen = true"><Sparkles :size="16" />{{ t('打开对话与上传文件', 'Open chat & attach files') }}</Button>

            <Button v-if="draft.proposal" variant="secondary" :disabled="busy" @click="agentOpen = true">{{ t('查看待应用建议', 'Review pending suggestion') }}</Button>
            <p class="agent-boundary">
                {{ t('名单只发送列名与脱敏样本；对话及当前正文会交给你配置的 AI。', 'Only column names and redacted samples are shared. Conversation and current content go to your configured AI.') }}
            </p>
            <div class="task-inspector">
                <h3>{{ t('任务上下文', 'Task context') }}</h3>
                <dl>
                    <div>
                        <dt>{{ t('模板', 'Template') }}</dt>
                        <dd>
                            {{ templates.find((item) => item.id === draft.templateId)?.name || t('未使用', 'None') }}
                        </dd>
                    </div>
                    <div>
                        <dt>{{ t('待完善项', 'Items to complete') }}</dt>
                        <dd>{{ issues.length }}</dd>
                    </div>
                    <div>
                        <dt>{{ t('保存状态', 'Save status') }}</dt>
                        <dd>
                            {{ savedCurrent ? t('服务器草稿', 'Server draft') : t('未保存编辑', 'Unsaved') }}
                        </dd>
                    </div>
                </dl>
                <!-- <Button variant="link" size="sm" @click="emit('settings')">{{ t('管理 AI 服务', 'Manage AI services') }}</Button> -->
            </div>
        </aside>
        <AgentDialog
            :key="draft.id"
            v-model:open="agentOpen"
            :blank="!draft.payload.html.trim()"
            :kind="draft.kind"
            :busy="busy"
            :title="draft.title"
            v-model:message="draft.message"
            v-model:attachments="draft.attachments"
            :conversation="draft.conversation"
            :proposal="draft.proposal"
            :t="t"
            @request="ask"
            @cancel="agentController?.abort()"
            @invalidate="draft.proposal = undefined"
            @apply="applyProposal"
            @settings="
                agentOpen = false;
                emit('settings');
            " />
        <Dialog v-model:open="applyTemplateOpen"
            ><DialogContent
                ><DialogHeader
                    ><DialogTitle>{{ t('应用模板？', 'Apply template?') }}</DialogTitle
                    ><DialogDescription>{{ t('仅替换当前主题和正文，收件人、日程信息与名单保持不变。现有正文将被覆盖。', 'Replaces subject and body only. Recipients, event details and imported data stay unchanged. Existing content will be overwritten.') }}</DialogDescription></DialogHeader
                >
                <div class="actions">
                    <Button variant="outline" @click="applyTemplateOpen = false">{{ t('保留当前内容', 'Keep content') }}</Button
                    ><Button @click="applyTemplate">{{ t('确认应用', 'Apply template') }}</Button>
                </div></DialogContent
            ></Dialog
        >
        <Dialog v-model:open="clearOpen"
            ><DialogContent
                ><DialogHeader
                    ><DialogTitle>{{ t('清除名单？', 'Clear imported data?') }}</DialogTitle
                    ><DialogDescription>{{ t('恢复手动收件人；正文不会改变，请处理未替换的字段。', 'Restores manual recipients. Content is unchanged; handle any unresolved fields.') }}</DialogDescription></DialogHeader
                >
                <div class="actions">
                    <Button variant="outline" @click="clearOpen = false">{{ t('返回', 'Back') }}</Button
                    ><Button variant="destructive" @click="clearData">{{ t('清除名单', 'Clear list') }}</Button>
                </div></DialogContent
            ></Dialog
        >
    </div>
</template>

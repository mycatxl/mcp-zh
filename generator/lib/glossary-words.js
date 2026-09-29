/**
 * Decides which tokens from a registry name are brands (must stay verbatim) and
 * which are ordinary vocabulary (should be translated).
 *
 * Registry names look like "agency.ottobot/business-contact-finder" or
 * "ad.getle/leads". The namespace part is usually a brand; the path part is
 * usually descriptive. We cannot tell them apart structurally, so we use a
 * vocabulary test: anything recognised as ordinary vocabulary is translatable,
 * everything else that appears in a name is treated as a brand and hidden
 * behind a marker.
 *
 * TWO SOURCES OF EVIDENCE, and the second one matters more than it looks:
 *
 *   1. the hand-written list below — curated, good at tooling vocabulary, and
 *      necessarily incomplete;
 *   2. CORPUS_GENERIC, generated from the registry corpus itself by
 *      generator/build-word-stats.js.
 *
 * A stoplist can never stay complete, and every word it misses is silently
 * treated as a brand and left in English — that is the whole reason titles came
 * out like "承包商执照 Changes" and "Licensed 房子 Painters". Measured against
 * the real corpus, the hand list alone left 15,859 name tokens protected across
 * 11,647 of 23,097 titles. Evidence (2) is what fixes that, without any
 * dictionary and without releasing genuine brands.
 *
 * The list below still has to be generous — a wrongly included word means a
 * brand gets translated — but it is no longer the only thing standing between
 * an ordinary English word and a half-English title.
 */

const TRANSPORT = [
  // transport / plumbing
  'mcp', 'api', 'apis', 'sdk', 'sdks', 'cli', 'http', 'https', 'sse', 'stdio', 'rest', 'graphql',
  'json', 'yaml', 'xml', 'csv', 'html', 'css', 'js', 'ts', 'oauth', 'auth', 'saml', 'sso', 'jwt',
  'webhook', 'webhooks', 'hook', 'hooks', 'token', 'tokens', 'key', 'keys', 'secret', 'secrets',
  'proxy', 'gateway', 'server', 'servers', 'client', 'clients', 'service', 'services', 'endpoint',
  'endpoints', 'integration', 'integrations', 'connector', 'connectors', 'plugin', 'plugins',
  'extension', 'extensions', 'bridge', 'adapter', 'runtime', 'host', 'hosting', 'protocol', 'schema',
  'stdio', 'transport', 'stream', 'streaming', 'sse', 'websocket', 'grpc', 'socket', 'port',
];

const GENERIC_NOUNS = [
  // software building blocks
  'app', 'apps', 'application', 'applications', 'tool', 'tools', 'toolkit', 'toolkits', 'util', 'utils',
  'utility', 'utilities', 'helper', 'helpers', 'library', 'libraries', 'lib', 'libs', 'framework',
  'frameworks', 'package', 'packages', 'module', 'modules', 'component', 'components', 'widget',
  'widgets', 'engine', 'kernel', 'core', 'base', 'layer', 'stack', 'suite', 'kit', 'bundle',
  // agents / ai
  'agent', 'agents', 'assistant', 'assistants', 'copilot', 'bot', 'bots', 'chatbot', 'automation',
  'automations', 'orchestration', 'orchestrator', 'pipeline', 'pipelines', 'workflow', 'workflows',
  'task', 'tasks', 'job', 'jobs', 'queue', 'scheduler', 'trigger', 'triggers', 'cron', 'batch',
  // content & docs
  'note', 'notes', 'file', 'files', 'document', 'documents', 'doc', 'docs', 'documentation', 'wiki',
  'knowledge', 'knowledgebase', 'content', 'text', 'markdown', 'pdf', 'sheet', 'sheets', 'slide',
  'slides', 'presentation', 'report', 'reports', 'reporting', 'template', 'templates', 'form', 'forms',
  'manual', 'reference', 'guide', 'guides', 'tutorial', 'tutorials', 'example', 'examples', 'faq',
  'blog', 'article', 'articles', 'post', 'posts', 'page', 'pages', 'site', 'sites', 'website',
  'websites', 'homepage', 'portal', 'hub', 'center', 'centre', 'board', 'panel', 'console',
  // data
  'data', 'dataset', 'datasets', 'database', 'databases', 'db', 'sql', 'nosql', 'query', 'queries',
  'table', 'tables', 'row', 'rows', 'column', 'columns', 'record', 'records', 'field', 'fields',
  'index', 'indexer', 'indices', 'cache', 'storage', 'bucket', 'blob', 'object', 'objects', 'file',
  'upload', 'download', 'sync', 'backup', 'restore', 'export', 'import', 'convert', 'converter',
  'parser', 'parse', 'validator', 'validate', 'formatter', 'format', 'normalizer', 'cleaner',
  'dedupe', 'migration', 'migrate', 'etl', 'warehouse', 'lake', 'pipeline', 'feed', 'feeds',
  // monitoring & quality
  'checker', 'scanner', 'scan', 'monitor', 'monitoring', 'observability', 'tracker', 'tracking',
  'analytics', 'metrics', 'telemetry', 'dashboard', 'dashboards', 'insight', 'insights', 'alert',
  'alerts', 'alerting', 'audit', 'auditing', 'compliance', 'governance', 'quality', 'health',
  'uptime', 'status', 'incident', 'incidents', 'debug', 'debugger', 'log', 'logs', 'logging',
  'trace', 'tracing', 'error', 'errors', 'exception', 'crash', 'perf', 'performance', 'latency',
  // search & discovery
  'explorer', 'explore', 'search', 'searcher', 'finder', 'find', 'lookup', 'filter', 'filters',
  'sort', 'rank', 'ranking', 'recommend', 'recommendation', 'recommendations', 'discover',
  'discovery', 'browse', 'browser', 'browsing', 'catalog', 'catalogue', 'directory', 'registry',
  'index', 'listing', 'listings', 'list', 'lists', 'collection', 'collections', 'gallery',
  // commerce
  'market', 'markets', 'marketplace', 'store', 'stores', 'shop', 'shopping', 'commerce',
  'ecommerce', 'retail', 'product', 'products', 'inventory', 'stock', 'warehouse', 'order',
  'orders', 'cart', 'checkout', 'payment', 'payments', 'pay', 'invoice', 'invoices', 'billing',
  'subscription', 'subscriptions', 'pricing', 'price', 'prices', 'quote', 'quotes', 'discount',
  'coupon', 'shipping', 'delivery', 'logistics', 'supply', 'vendor', 'vendors', 'supplier',
  // business
  'crm', 'erp', 'ats', 'hris', 'hr', 'recruit', 'recruiting', 'recruitment', 'hiring', 'candidate',
  'candidates', 'resume', 'sales', 'lead', 'leads', 'prospect', 'prospects', 'customer', 'customers',
  'client', 'account', 'accounts', 'contact', 'contacts', 'company', 'companies', 'business',
  'businesses', 'org', 'organization', 'organisation', 'enterprise', 'startup', 'agency', 'agency',
  'team', 'teams', 'user', 'users', 'member', 'members', 'profile', 'profiles', 'person', 'people',
  'employee', 'employees', 'staff', 'partner', 'partners', 'vendor', 'deal', 'deals', 'pipeline',
  // communication
  'email', 'emails', 'mail', 'mailer', 'inbox', 'newsletter', 'newsletters', 'sms', 'chat', 'chats',
  'message', 'messages', 'messaging', 'notify', 'notification', 'notifications', 'reminder',
  'reminders', 'comment', 'comments', 'reply', 'replies', 'thread', 'threads', 'channel', 'channels',
  'conversation', 'conversations', 'call', 'calls', 'voice', 'video', 'meeting', 'meetings',
  'calendar', 'calendars', 'schedule', 'scheduler', 'scheduling', 'event', 'events', 'invite',
  'attendee', 'attendees', 'room', 'rooms',
  // social & media
  'social', 'media', 'network', 'networks', 'follower', 'followers', 'following', 'friend',
  'friends', 'like', 'likes', 'share', 'shares', 'story', 'stories', 'reel', 'reels', 'stream',
  'livestream', 'podcast', 'podcasts', 'news', 'rss', 'newsletter', 'press', 'review', 'reviews',
  'rating', 'ratings', 'feedback', 'survey', 'surveys', 'poll', 'polls', 'vote', 'votes',
  // web & crawling
  'web', 'webpage', 'link', 'links', 'url', 'urls', 'domain', 'domains', 'dns', 'hostname', 'seo',
  'sem', 'crawl', 'crawler', 'crawling', 'scrape', 'scraper', 'scraping', 'fetch', 'fetcher',
  'screenshot', 'screenshots', 'render', 'rendering', 'preview', 'thumbnail', 'pdf', 'extract',
  'extractor', 'extraction', 'reader', 'readability', 'metadata', 'sitemap', 'robots', 'proxy',
  // media files
  'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'gallery', 'avatar', 'icon', 'icons',
  'logo', 'logos', 'graphic', 'graphics', 'design', 'designer', 'illustration', 'vector', 'svg',
  'font', 'fonts', 'color', 'colors', 'palette', 'theme', 'themes', 'style', 'styles', 'layout',
  'animation', 'video', 'videos', 'movie', 'movies', 'clip', 'clips', 'audio', 'sound', 'music',
  'song', 'songs', 'playlist', 'transcript', 'transcription', 'subtitle', 'subtitles', 'speech',
  'voice', 'tts', 'stt', 'ocr', 'vision', 'caption', 'captions',
  // ai / ml
  'translate', 'translation', 'translator', 'summary', 'summarize', 'summarizer', 'summarization',
  'classify', 'classification', 'classifier', 'detect', 'detection', 'detector', 'predict',
  'prediction', 'forecast', 'forecasting', 'cluster', 'clustering', 'segment', 'segmentation',
  'enrich', 'enrichment', 'verify', 'verification', 'moderate', 'moderation', 'guardrail',
  'guardrails', 'safety', 'prompt', 'prompts', 'context', 'memory', 'rag', 'retrieval', 'retriever',
  'embedding', 'embeddings', 'vector', 'vectors', 'semantic', 'similarity', 'model', 'models',
  'llm', 'llms', 'inference', 'training', 'finetune', 'finetuning', 'benchmark', 'benchmarks',
  'evaluation', 'eval', 'annotation', 'annotator', 'label', 'labeling', 'labelling', 'dataset',
  // developer tooling
  'code', 'coding', 'developer', 'developers', 'dev', 'devs', 'devops', 'sre', 'platform',
  'git', 'github', 'gitlab', 'bitbucket', 'repo', 'repos', 'repository', 'repositories', 'branch',
  'branches', 'commit', 'commits', 'merge', 'diff', 'patch', 'tag', 'tags', 'release', 'releases',
  'issue', 'issues', 'bug', 'bugs', 'ticket', 'tickets', 'pull', 'request', 'requests', 'review',
  'reviewer', 'milestone', 'project', 'projects', 'sprint', 'board', 'backlog', 'epic', 'story',
  'build', 'builds', 'builder', 'compile', 'compiler', 'bundle', 'bundler', 'ci', 'cd', 'test',
  'tests', 'testing', 'tester', 'lint', 'linter', 'format', 'formatter', 'typecheck', 'coverage',
  'deploy', 'deployment', 'release', 'rollback', 'provision', 'terraform', 'ansible', 'helm',
  'docker', 'container', 'containers', 'kubernetes', 'k8s', 'cluster', 'pod', 'pods', 'node',
  'nodes', 'cloud', 'aws', 'azure', 'gcp', 'serverless', 'function', 'functions', 'lambda',
  'worker', 'workers', 'edge', 'cdn', 'bucket', 'region', 'zone', 'vm', 'instance', 'instances',
  'shell', 'terminal', 'bash', 'powershell', 'command', 'commands', 'script', 'scripts', 'scripting',
  'config', 'configuration', 'settings', 'setting', 'option', 'options', 'preference', 'admin',
  'administration', 'dashboard', 'cli', 'dotenv', 'env', 'variable', 'variables', 'flag', 'flags',
  'secret', 'credential', 'credentials', 'permission', 'permissions', 'role', 'roles', 'scope',
  'access', 'auth', 'login', 'logout', 'signup', 'signin', 'session', 'sessions',
  // languages & runtimes (generic, translatable)
  'python', 'typescript', 'javascript', 'java', 'golang', 'rust', 'php', 'ruby', 'kotlin', 'swift',
  'scala', 'elixir', 'haskell', 'perl', 'lua', 'r', 'matlab', 'sql', 'nosql', 'shell', 'c', 'cpp',
  // security
  'security', 'secure', 'vulnerability', 'vulnerabilities', 'cve', 'malware', 'threat', 'threats',
  'firewall', 'encryption', 'encrypt', 'decrypt', 'hash', 'hashing', 'signature', 'certificate',
  'pentest', 'penetration', 'scanner', 'secrets', 'rotation', 'policy', 'policies', 'blocklist',
  'allowlist', 'blacklist', 'whitelist', 'spam', 'phishing', 'fraud', 'abuse', 'risk', 'risks',
  // legal / finance / verticals
  'legal', 'law', 'lawyer', 'contract', 'contracts', 'license', 'licence', 'licenses', 'permit',
  'permits', 'regulation', 'regulations', 'regulated', 'compliance', 'tax', 'taxes', 'accounting',
  'payroll', 'finance', 'financial', 'bank', 'banking', 'loan', 'loans', 'credit', 'mortgage',
  'insurance', 'invest', 'investment', 'investor', 'fund', 'funds', 'portfolio', 'asset', 'assets',
  'trade', 'trading', 'trader', 'stock', 'stocks', 'equity', 'bond', 'bonds', 'option', 'options',
  'crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'blockchain', 'wallet', 'wallets', 'nft',
  'defi', 'exchange', 'swap', 'liquidity', 'staking', 'validator', 'gas', 'transaction',
  'transactions', 'ledger', 'token', 'tokenomics',
  // property / travel / health / education / science
  'property', 'properties', 'real', 'estate', 'housing', 'home', 'homes', 'house', 'houses',
  'apartment', 'apartments', 'rental', 'rentals', 'tenant', 'tenants', 'landlord', 'listing',
  'travel', 'trip', 'trips', 'flight', 'flights', 'airline', 'hotel', 'hotels', 'booking',
  'reservation', 'itinerary', 'tour', 'tours', 'map', 'maps', 'mapping', 'location', 'locations',
  'geo', 'geocoding', 'route', 'routes', 'directions', 'traffic', 'transit', 'weather', 'climate',
  'forecast', 'health', 'healthcare', 'medical', 'medicine', 'doctor', 'patient', 'patients',
  'clinic', 'hospital', 'symptom', 'diagnosis', 'drug', 'drugs', 'fitness', 'workout', 'exercise',
  'nutrition', 'diet', 'food', 'recipe', 'recipes', 'restaurant', 'restaurants', 'menu', 'meal',
  'education', 'course', 'courses', 'learning', 'learn', 'teach', 'teacher', 'student', 'students',
  'school', 'university', 'college', 'exam', 'quiz', 'grade', 'grades', 'lesson', 'lessons',
  'research', 'paper', 'papers', 'arxiv', 'journal', 'science', 'scientific', 'study', 'studies',
  'math', 'statistics', 'stats', 'physics', 'chemistry', 'biology', 'genome', 'protein', 'chemical',
  // government / public data
  'government', 'gov', 'public', 'civic', 'city', 'state', 'country', 'county', 'national',
  'federal', 'municipal', 'census', 'population', 'demographic', 'demographics', 'election',
  'regulation', 'court', 'case', 'cases', 'filing', 'filings', 'patent', 'patents', 'trademark',
  // sports / entertainment / misc
  'sport', 'sports', 'game', 'games', 'gaming', 'esports', 'team', 'player', 'players', 'league',
  'match', 'matches', 'score', 'scores', 'stats', 'tournament', 'betting', 'odds', 'fantasy',
  'entertainment', 'event', 'events', 'venue', 'ticket', 'tickets', 'festival', 'concert',
  'charity', 'donation', 'donations', 'nonprofit', 'volunteer', 'community', 'forum', 'discord',
  'slack', 'telegram', 'whatsapp', 'wechat', 'twitter', 'mastodon', 'reddit', 'youtube', 'twitch',
  // common modifiers / adjectives / verbs seen in names
  'smart', 'auto', 'automatic', 'automated', 'custom', 'personal', 'personalized', 'private',
  'public', 'global', 'local', 'remote', 'online', 'offline', 'cloud', 'cloudnative', 'mobile',
  'desktop', 'native', 'hybrid', 'multi', 'single', 'full', 'mini', 'micro', 'macro', 'mega',
  'ultra', 'super', 'hyper', 'meta', 'next', 'last', 'first', 'primary', 'secondary', 'main',
  'side', 'front', 'back', 'top', 'best', 'free', 'open', 'fast', 'quick', 'simple', 'easy',
  'deep', 'wide', 'broad', 'light', 'heavy', 'lite', 'pro', 'plus', 'max', 'premium', 'basic',
  'standard', 'advanced', 'enterprise', 'modern', 'legacy', 'classic', 'new', 'old', 'beta',
  'alpha', 'stable', 'unstable', 'live', 'realtime', 'real-time', 'instant', 'instantaneous',
  'dynamic', 'static', 'interactive', 'visual', 'visualization', 'chart', 'charts', 'graph',
  'graphs', 'diagram', 'diagrams', 'plot', 'plots', 'timeline', 'gantt', 'kanban', 'calendar',
  'inside', 'insider', 'outside', 'internal', 'external', 'inbound', 'outbound', 'upstream',
  'downstream', 'source', 'target', 'input', 'output', 'result', 'results', 'response', 'request',
  'ad', 'ads', 'advert', 'advertising', 'campaign', 'campaigns', 'marketing', 'brand', 'branding',
  'growth', 'funnel', 'conversion', 'engagement', 'retention', 'churn', 'audience', 'segment',
  'persona', 'creative', 'copywriting', 'copy', 'landing', 'banner', 'banners', 'impression',
  'click', 'clicks', 'ctr', 'roi', 'kpi', 'kpis', 'okr', 'okrs', 'goal', 'goals', 'objective',
  'strategy', 'strategic', 'plan', 'plans', 'planning', 'roadmap', 'vision', 'mission', 'value',
  'values', 'culture', 'team', 'collaboration', 'collab', 'productivity', 'efficiency', 'workflow',
  'notes', 'todo', 'todos', 'checklist', 'checklists', 'reminder', 'reminders', 'habit', 'habits',
  'goal', 'goals', 'tracker', 'planner', 'planners', 'journal', 'diary', 'log', 'logging',
  'time', 'timesheet', 'timesheets', 'timer', 'stopwatch', 'clock', 'date', 'dates', 'day', 'days',
  'week', 'weeks', 'month', 'months', 'year', 'years', 'hour', 'hours', 'minute', 'minutes',
  'today', 'tomorrow', 'yesterday', 'morning', 'evening', 'night', 'noon', 'midnight', 'daily',
  'weekly', 'monthly', 'yearly', 'annual', 'quarterly', 'seasonal',
  // travel/geo extras and common words
  'name', 'names', 'naming', 'service', 'services', 'solution', 'solutions', 'system', 'systems',
  'platform', 'platforms', 'infrastructure', 'infra', 'network', 'networking', 'device', 'devices',
  'iot', 'sensor', 'sensors', 'hardware', 'firmware', 'driver', 'drivers', 'printer', 'printer',
  'scan', 'scanner', 'camera', 'cameras', 'robot', 'robotics', 'drone', 'drones', 'gps', 'nfc',
  'rfid', 'qr', 'barcode', 'barcodes', 'label', 'labels', 'tag', 'tags', 'sticker', 'packaging',
  'shipping', 'freight', 'courier', 'parcel', 'parcels', 'tracking', 'warehouse', 'warehousing',
  'fulfillment', 'returns', 'refund', 'refunds', 'warranty', 'repair', 'maintenance', 'field',
  'workforce', 'shift', 'shifts', 'roster', 'attendance', 'leave', 'timesheet', 'expense',
  'expenses', 'receipt', 'receipts', 'reimburse', 'procurement', 'purchase', 'purchases', 'vendor',
  'contract', 'contractor', 'contractors', 'subcontractor', 'bidding', 'tender', 'tenders', 'rfp',
  'proposal', 'proposals', 'estimate', 'estimates', 'estimation', 'measurement', 'measure',
  'inspection', 'inspections', 'safety', 'permit', 'permits', 'code', 'codes', 'standard',
  'standards', 'specification', 'specifications', 'blueprint', 'blueprints', 'floorplan', 'cad',
  'bim', 'construction', 'building', 'buildings', 'architect', 'architecture', 'engineering',
  'energy', 'solar', 'wind', 'grid', 'utility', 'utilities', 'emission', 'emissions', 'carbon',
  'sustainability', 'esg', 'recycling', 'waste', 'water', 'air', 'soil', 'agriculture', 'farm',
  'farming', 'crop', 'crops', 'livestock', 'harvest', 'food', 'beverage', 'restaurant', 'kitchen',
  'menu', 'order', 'orders', 'reservation', 'reservations', 'hospitality', 'guest', 'guests',
  'booking', 'bookings', 'availability', 'room', 'rooms', 'amenity', 'amenities', 'review',
  'reviews', 'rating', 'ratings',
];

/** Extra short common words that frequently appear in registry names. */
const COMMON_SHORT = [
  'and', 'the', 'for', 'with', 'from', 'into', 'over', 'under', 'about', 'above', 'below', 'after',
  'before', 'between', 'during', 'through', 'across', 'against', 'around', 'behind', 'beyond',
  'any', 'all', 'some', 'each', 'every', 'both', 'either', 'neither', 'many', 'much', 'more',
  'most', 'less', 'least', 'few', 'several', 'other', 'others', 'another', 'same', 'own', 'such',
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose', 'that', 'this', 'these', 'those',
  'you', 'your', 'yours', 'our', 'ours', 'their', 'theirs', 'his', 'her', 'hers', 'its', 'my',
  'me', 'we', 'us', 'they', 'them', 'he', 'she', 'it', 'i',
  'get', 'got', 'give', 'gives', 'take', 'takes', 'make', 'makes', 'made', 'do', 'does', 'did',
  'have', 'has', 'had', 'be', 'is', 'are', 'was', 'were', 'been', 'being', 'can', 'could', 'will',
  'would', 'shall', 'should', 'may', 'might', 'must', 'let', 'lets', 'keep', 'keeps', 'put', 'puts',
  'see', 'sees', 'saw', 'seen', 'look', 'looks', 'find', 'finds', 'found', 'know', 'knows', 'knew',
  'think', 'thinks', 'want', 'wants', 'need', 'needs', 'use', 'uses', 'used', 'using', 'help',
  'helps', 'work', 'works', 'working', 'run', 'runs', 'running', 'send', 'sends', 'sent', 'read',
  'reads', 'write', 'writes', 'written', 'edit', 'edits', 'update', 'updates', 'delete', 'deletes',
  'add', 'adds', 'added', 'remove', 'removes', 'create', 'creates', 'created', 'build', 'builds',
  'start', 'starts', 'stop', 'stops', 'open', 'opens', 'close', 'closes', 'show', 'shows', 'view',
  'views', 'list', 'lists', 'check', 'checks', 'test', 'tests', 'try', 'tries', 'play', 'plays',
  'learn', 'learns', 'teach', 'teaches', 'study', 'studies', 'manage', 'manages', 'managed',
  'monitor', 'monitors', 'track', 'tracks', 'report', 'reports', 'analyze', 'analyzes', 'analyse',
  'analyse', 'explore', 'explores', 'search', 'searches', 'find', 'finders', 'convert', 'converts',
  'extract', 'extracts', 'import', 'imports', 'export', 'exports', 'sync', 'syncs', 'backup',
  'restore', 'deploy', 'deploys', 'install', 'installs', 'setup', 'set', 'configure', 'configures',
  'enable', 'enables', 'disable', 'disables', 'connect', 'connects', 'integrate', 'integrates',
  'publish', 'publishes', 'share', 'shares', 'notify', 'notifies', 'alert', 'alerts', 'schedule',
  'schedules', 'trigger', 'triggers', 'execute', 'executes', 'generate', 'generates', 'generate',
  'summarize', 'summarizes', 'translate', 'translates', 'review', 'reviews', 'approve', 'approves',
  'assign', 'assigns', 'label', 'labels', 'tag', 'tags', 'group', 'groups', 'merge', 'merges',
  'split', 'splits', 'join', 'joins', 'filter', 'filters', 'sort', 'sorts', 'rank', 'ranks',
  'score', 'scores', 'measure', 'measures', 'count', 'counts', 'compare', 'compares', 'validate',
  'validates', 'verify', 'verifies', 'format', 'formats', 'parse', 'parses', 'render', 'renders',
  'preview', 'previews', 'download', 'downloads', 'upload', 'uploads', 'stream', 'streams',
  'proxy', 'proxies', 'route', 'routes', 'map', 'maps', 'geocode', 'geocodes', 'encrypt',
  'encrypts', 'decrypt', 'decrypts', 'sign', 'signs', 'hash', 'hashes',
  'new', 'old', 'good', 'better', 'best', 'bad', 'worse', 'worst', 'big', 'bigger', 'biggest',
  'small', 'smaller', 'smallest', 'large', 'larger', 'largest', 'long', 'longer', 'longest',
  'short', 'shorter', 'shortest', 'high', 'higher', 'highest', 'low', 'lower', 'lowest', 'fast',
  'faster', 'fastest', 'slow', 'slower', 'slowest', 'easy', 'easier', 'easiest', 'hard', 'harder',
  'hardest', 'simple', 'simpler', 'simplest', 'smart', 'smarter', 'smartest', 'rich', 'richer',
  'poor', 'clean', 'dirty', 'safe', 'unsafe', 'secure', 'insecure', 'public', 'private', 'secret',
  'hidden', 'visible', 'active', 'inactive', 'enabled', 'disabled', 'available', 'unavailable',
  'ready', 'pending', 'done', 'complete', 'incomplete', 'valid', 'invalid', 'correct', 'wrong',
  'true', 'false', 'yes', 'no', 'on', 'off', 'up', 'down', 'in', 'out', 'over', 'under',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred',
  'thousand', 'million', 'billion', 'first', 'second', 'third', 'fourth', 'fifth', 'last',
  'next', 'previous', 'prev', 'current', 'recent', 'latest', 'oldest', 'newest', 'early', 'late',
  'daily', 'weekly', 'monthly', 'hourly', 'yearly', 'always', 'never', 'sometimes', 'often',
  'once', 'twice', 'again', 'already', 'still', 'yet', 'soon', 'now', 'then', 'here', 'there',
  'near', 'far', 'away', 'back', 'forward', 'upward', 'downward', 'left', 'right', 'center',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western',
];


// Generated from the corpus; lists words that are ordinary vocabulary rather
// than part of a brand. See generator/build-word-stats.js.
import { CORPUS_GENERIC } from './word-stats.generated.js';
export const GENERIC_WORDS = new Set([...TRANSPORT, ...GENERIC_NOUNS, ...COMMON_SHORT].map((w) => w.toLowerCase()));

/** True when the hand-written list says the token is ordinary vocabulary. */
export function isGenericWord(token) {
  return GENERIC_WORDS.has(String(token).toLowerCase());
}

/**
 * Plausible base forms of an English word.
 *
 * The hand list holds base forms, but registry names are full of inflections:
 * "changes", "licensed", "painters", "signals". Checking the inflected form
 * only means those miss the list and get treated as brands. Stripping common
 * endings is enough to hit the base form, and every candidate is checked
 * against the list, so a wrong guess costs nothing.
 */
function stems(word) {
  const w = word.toLowerCase();
  const out = [w];
  if (w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.endsWith('s')) out.push(w.slice(0, -1));
  if (w.endsWith('ed')) out.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith('ing')) out.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
  if (w.endsWith('er')) out.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith('or')) out.push(w.slice(0, -2));
  if (w.endsWith('ly')) out.push(w.slice(0, -2));
  return out;
}

/**
 * True when the token is ordinary vocabulary, from either source of evidence:
 *
 *   1. the hand-written list (also via a stripped base form), or
 *   2. CORPUS_GENERIC — words the corpus itself shows are used far beyond the
 *      records that name them. See generator/build-word-stats.js.
 *
 * Evidence (2) is what fixes the bulk of the mixed-language titles: a stoplist
 * cannot stay complete, and every word it missed was silently treated as a
 * brand and left in English.
 */
export function isOrdinaryWord(token) {
  const candidates = new Set(stems(token));
  for (const w of candidates) {
    if (w.length >= 3 && GENERIC_WORDS.has(w)) return true;
    if (CORPUS_GENERIC.has(w)) return true;
  }
  return false;
}

/**
 * Brand-ish tokens worth protecting, derived from a registry name.
 * Registry names look like "agency.ottobot/business-contact-finder" — the
 * namespace part is almost always a brand, the path part often is too.
 */
export function nameTokens(registryName) {
  const out = new Set();
  for (const part of String(registryName ?? '').split(/[/.@_-]+/)) {
    const t = part.trim();
    if (t.length < 3) continue;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(t)) continue;
    if (isOrdinaryWord(t)) continue;
    out.add(t);
  }
  return out;
}

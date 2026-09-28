// Does the extracted host mapper actually run and decide correctly?
import * as m from '../generator/lib/host-mapper.generated.js';

console.log('exports:', Object.keys(m).sort().join(', '));
console.log('');

function show(label, rec) {
  let entry;
  try {
    entry = m.mapRegistryServer(rec);
  } catch (e) {
    console.log(`${label.padEnd(24)} THREW ${e.message}`);
    return null;
  }
  if (!entry) {
    console.log(`${label.padEnd(24)} null  (client would drop this record)`);
    return null;
  }
  console.log(
    `${label.padEnd(24)} id=${entry.id}  transport=${entry.transport}` +
      (entry.command ? `  command=${entry.command}` : '') +
      (entry.url ? `  url=${entry.url}` : '') +
      (entry.args?.length ? `  args=${JSON.stringify(entry.args)}` : '') +
      (entry.requiredEnv ? `  requiredEnv=${JSON.stringify(entry.requiredEnv.map((r) => r.name))}` : ''),
  );
  return entry;
}

show('npm package', { server: { name: 'ac.example/mcp', title: 'X', description: 'd', packages: [{ registryType: 'npm', identifier: 'foo', version: '1.0.0' }] } });
show('pypi package', { server: { name: 'ac.py/mcp', title: 'Y', packages: [{ registryType: 'pypi', identifier: 'bar' }] } });
show('https remote', { server: { name: 'ac.rm/mcp', title: 'Z', remotes: [{ type: 'streamable-http', url: 'https://api.example.com/mcp' }] } });
show('no package/remote', { server: { name: 'ac.no/mcp', title: 'W' } });
show('loopback remote', { server: { name: 'ac.loc/mcp', remotes: [{ type: 'streamable-http', url: 'https://127.0.0.1:3000/mcp' }] } });
show('http (not https)', { server: { name: 'ac.h/mcp', remotes: [{ type: 'streamable-http', url: 'http://api.example.com/mcp' }] } });

// env placeholders: the classic silent-drop trap
show('npm + declared env', {
  server: {
    name: 'ac.env/mcp',
    packages: [{ registryType: 'npm', identifier: 'e', environmentVariables: [{ name: 'API_KEY', isRequired: true }] }],
  },
});

console.log('');
console.log('registryIdFromName("ac.inference.sh/mcp")        =', m.registryIdFromName('ac.inference.sh/mcp'));
console.log('registryIdFromName("ac.inference.sh/mcp/zh/api") =', m.registryIdFromName('ac.inference.sh/mcp/zh/api'));
const long = 'io.github.someverylongorganisationname/someverylongservername-here';
console.log('truncation, plain     =', m.registryIdFromName(long));
console.log('truncation, with /zh/ =', m.registryIdFromName(`${long}/zh/api`));
console.log('');
console.log('guessCategory(english) =', m.guessCategory({ name: 'x', title: 'Database tools', description: 'query' }));
console.log('guessCategory(chinese) =', m.guessCategory({ name: 'x/zh/api', title: '数据库工具', description: '查询' }));
console.log('guessCategory(hinted)  =', m.guessCategory({ name: 'x/zh/api/database', title: '数据库工具', description: '查询' }));

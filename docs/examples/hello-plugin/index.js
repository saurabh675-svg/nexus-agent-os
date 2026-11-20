/** Example Nexus plugin — copy this folder to data/plugins/hello/ */
export async function activate(api) {
  api.registerTool('hello_world', {
    desc: 'Example plugin tool that greets a name',
    params: { name: 'string?' },
    async run({ name }) {
      return { ok: true, message: `Hello ${name || 'world'} from the hello plugin.` };
    },
  });
  return () => {};
}

const generator = require('../../desktop/scope-extension/lib/node/nodu-daxin-project');
const create = generator.createDaxinProject;
generator.createDaxinProject = input => create(input, '/Users/wangwei/Model/dacir-templates');
require('../../desktop/scripts/daxin-templates-host.test.cjs');

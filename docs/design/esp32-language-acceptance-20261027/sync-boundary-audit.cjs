const {arduinoPatchedChange:change}=require('/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scripts/arduino-language-sync.cjs');
const cases=[
 ['namespace', 'namespace N {\nvoid foo();\nvoid bar();\n}\n','namespace N {\nvoid renamed();\nvoid added();\nvoid bar();\n}\n',true],
 ['class','struct Driver {\nvoid foo();\nvoid bar();\n};\n','struct Driver {\nvoid renamed();\nvoid added();\nvoid bar();\n};\n',true],
 ['global initializer','int a[] = {\n1, 2,\n3\n};\n','int a[] = {\n1, 2,\n4, 5,\n3\n};\n',true],
 ['function name','void setup() {\nrun();\n}\n','void setup2() {\nrun();\n}\n',true],
 ['include','#include <Wire.h>\nvoid setup() {}\n','#include <SPI.h>\nvoid setup() {}\n',true],
 ['macro continuation','#define OPEN \\\n{\nvoid foo();\nvoid bar();\n','#define OPEN \\\n{\nvoid renamed();\nvoid added();\nvoid bar();\n',true],
 ['comment continuation','// comment \\\n{\nvoid foo();\nvoid bar();\n','// comment \\\n{\nvoid renamed();\nvoid added();\nvoid bar();\n',true],
 ['same-line boundary','void loop() {\n  run();\n}\n','void loop() {\n  run(); } void added() {\n}\n',true],
 ['body directive','void loop() {\n  run();\n}\n','void loop() {\n  #include <Wire.h>\n}\n',true],
 ['CRLF conversion','void loop() {\n  run();\r\n}\n','void loop() {\n  run();\n}\n',true],
 ['unicode body','void loop() {\n  Serial.println("中文 😀");\n}\n','void loop() {\n  Serial.println("新的 😀");\n}\n',false],
 ['body newline','void loop() {\n  run();\n}\n','void loop() {\n  run();\n  next();\n}\n',false],
 ['CRLF body text','void loop() {\r\n  run();\r\n}\r\n','void loop() {\r\n  next();\r\n}\r\n',false],
 ['raw string','void loop() {\n auto a=R"x( } )x";\n run();\n}\n','void loop() {\n auto a=R"x( } )x";\n run();\n next();\n}\n',true],
];
let failed=0;for(const [name,before,after,reopen]of cases){const result=change(before,after);const ok=!!result.reopen===reopen;failed+=!ok;console.log(JSON.stringify({name,ok,reopen:!!result.reopen,...(ok?{}:{result})}));}process.exitCode=failed?1:0;

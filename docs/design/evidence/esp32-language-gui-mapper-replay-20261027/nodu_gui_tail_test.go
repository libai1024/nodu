package sourcemapper
import("encoding/json";"os";"strings";"testing";"go.bug.st/lsp";"github.com/arduino/go-paths-helper")
func TestGuiEnterPasteTailSymbols(t *testing.T){
 root:=os.Getenv("NODU_GUI_FIXTURES");if root==""{t.Fatal("Set NODU_GUI_FIXTURES to the archived fixture directory") }
 cpp,err:=os.ReadFile(root+"/before.cpp");if err!=nil{t.Fatal(err)}
 b,err:=os.ReadFile(root+"/events.json");if err!=nil{t.Fatal(err)}
 var events []struct{Name string; After string; Raw lsp.TextDocumentContentChangeEvent};if err=json.Unmarshal(b,&events);err!=nil{t.Fatal(err)}
 uri:=lsp.NewDocumentURIFromPath(paths.New("/private/tmp/nodu-arduino-electron-20261027/projects/arduino_ui_c3/arduino_ui_c3.ino"))
 mapper:=CreateInoMapper(cpp)
 for _,event:=range events{
   mapper.ApplyTextChange(uri,event.Raw)
   lines:=strings.Split(mapper.CppText.Text,"\n")
   for line,text:=range strings.Split(event.After,"\n"){
     if strings.Contains(text,"JsonDocument")||strings.Contains(text,"serializeJson")||strings.HasPrefix(text,"void loop"){
       target,ok:=mapper.InoToCppLineOk(uri,line)
       if !ok||target>=len(lines)||lines[target]!=text {t.Errorf("%s: ino %d %q mapped cpp %d %q",event.Name,line,text,target,lines[target])} else{t.Logf("%s: ino %d -> cpp %d %q",event.Name,line,target,text)}
     }
   }
 }
}

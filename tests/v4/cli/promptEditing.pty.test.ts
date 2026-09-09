import { it, expect } from 'vitest';
import path from 'node:path';
import * as pty from 'node-pty';
import { killPtyIfRunning } from '../harness/ptyProcessLifecycle';

const fixture=path.resolve(__dirname,'../harness/promptEditingPtyFixture.ts');
const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
for(const host of process.platform==='win32'?['direct','powershell']:['direct']){
  it(`preserves native readline editing and terminal restoration through ${host}`,async()=>{
    const args=['-r','ts-node/register/transpile-only',fixture];
    const shell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child=pty.spawn(host==='powershell'?shell:process.execPath,host==='powershell'?['-NoLogo','-NoProfile','-Command',`& ${[process.execPath,...args].map(quote).join(' ')}`]:args,{
      // The owned PTY supports cursor editing. Do not inherit a diagnostic
      // TERM=dumb claim; NO_COLOR remains an intentional independent preference.
      cwd:path.resolve(__dirname,'../../..'),cols:100,rows:30,env:{...process.env,TERM:'xterm-256color',AIDEN_NO_UPDATE_CHECK:'1',NO_COLOR:'1'},
    });
    let output='';let sent=false;const timers:Array<ReturnType<typeof setTimeout>>=[];
    const keys=['a','b','c','X','\x7f','\x1b[D','Z','\x1b[C','\x08','\x1b[H','\x1b[3~','\x1b[F','資料','\r'];
    try{
      const exit=await new Promise<number>((resolve,reject)=>{
        const limit=setTimeout(()=>reject(Error('Prompt editing did not complete')),15000);timers.push(limit);
        child.onData(chunk=>{output+=chunk;if(!sent&&output.includes('[EDIT_READY]')){sent=true;keys.forEach((key,index)=>timers.push(setTimeout(()=>child.write(key),200+index*120)));}});
        child.onExit(({exitCode})=>{clearTimeout(limit);resolve(exitCode);});
      });
      expect(exit).toBe(0);
      const match=output.match(/\[EDIT_RESULT\](\{[^\r\n]+\})/);expect(match).not.toBeNull();
      const result=JSON.parse(match![1]);
      expect(result.value).toBe('bZ資料');expect(result.rawRestored).toBe(true);
      expect(result.stdinTTY&&result.stdoutTTY&&result.stderrTTY).toBe(true);
      expect(result.values).toContainEqual({value:'abc',cursor:3});
      expect(result.values).toContainEqual({value:'abZc',cursor:3});
      expect(result.values).toContainEqual({value:'abZ',cursor:3});
      expect(result.values).toContainEqual({value:'bZ',cursor:0});
    }finally{timers.forEach(clearTimeout);killPtyIfRunning(child);}
  },20000);
}

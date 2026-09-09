import aidenPrompt from '../../../cli/v4/aidenPrompt';

const values: Array<{value:string;cursor:number}> = [];
const before = process.stdin.isRaw === true;
void aidenPrompt({message:'Aiden',commands:[],history:[],fixedComposer:{
  ready(){process.stdout.write('\n[EDIT_READY]\n');},
  update(value,_hint,cursor){values.push({value,cursor});},
}}).then(value=>{
  process.stdout.write('\n[EDIT_RESULT]'+JSON.stringify({value,values,rawRestored:(process.stdin.isRaw===true)===before,stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY,stderrTTY:process.stderr.isTTY})+'\n');
});

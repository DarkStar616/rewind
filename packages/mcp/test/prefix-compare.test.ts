import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRequestPrefix } from "../src/prefix-compare.ts";
const request = (content: unknown[] = [{type:"text",text:"alpha"}]) => ({model:"m",system:"stable",messages:[{role:"user",content}]});
test("exact histories and whole-message/block appends report conservative stable prefixes",()=>{
 const a=request(); assert.equal(compareRequestPrefix(a,structuredClone(a)).relation,"exact");
 const b=structuredClone(a);b.messages.push({role:"user",content:[]});
 assert.equal(compareRequestPrefix(a,b).relation,"message-append");
 const result=compareRequestPrefix(a,request([{type:"text",text:"alpha"},{type:"text",text:"beta"}]));
 assert.equal(result.relation,"block-append");assert.equal(result.stableBlocks,1);assert.equal(result.stableMessages,0);
 assert.equal(result.advisoryOnly,true);assert.equal(result.providerCacheHit,"unknown");
});
test("every request setting remains significant, including unknown and prototype-named JSON keys",()=>{
 const a=request();
 for(const key of ["model","system","tools","cache_control","future_setting","__proto__"]){
  const b=JSON.parse(JSON.stringify(a));Object.defineProperty(b,key,{value:"secret-value",enumerable:true});
  const result=compareRequestPrefix(a,b);assert.equal(result.relation,"diverged",key);assert.equal(result.stableMessages,0);
  assert.ok(!JSON.stringify(result).includes("secret-value"));
 }
});
test("block edits, shortened histories and metadata changes diverge without treating suffixes as safe",()=>{
 const a=request([{type:"text",text:"a"},{type:"text",text:"b"}]);
 const result=compareRequestPrefix(a,request([{type:"text",text:"a"},{type:"text",text:"changed"}]));
 assert.equal(result.relation,"diverged");assert.equal(result.stableBlocks,1);assert.equal(result.firstChangedPath,"$.messages[0].content[1]");
 assert.equal(compareRequestPrefix(a,{...a,messages:[]}).relation,"diverged");
 assert.equal(compareRequestPrefix(a,{...a,messages:[{...a.messages[0],role:"assistant"}]}).stableBlocks,0);
 const earlier={...a,messages:[...a.messages,{role:"assistant",content:[]}]};
 const appendedEarlier=structuredClone(earlier);appendedEarlier.messages[0].content.push({type:"text",text:"new"});
 assert.equal(compareRequestPrefix(earlier,appendedEarlier).relation,"diverged","insertion before subsequent history is not append-only");
});
test("malformed, cyclic, accessor and excessive inputs fail without echoing content or invoking getters",()=>{
 const cycle:any={};cycle.self=cycle;let calls=0;
 const accessor={messages:[],get secret(){calls++;return "secret";}};
 for(const input of [null,[],{messages:"bad"},{messages:[null]},cycle,accessor,{messages:[],x:NaN},{messages:[],x:undefined},{messages:[],x:"x".repeat(2_100_000)}]) assert.throws(()=>compareRequestPrefix(input,request()),/prefix comparison/);
 assert.equal(calls,0);
 let deep:any=0;for(let i=0;i<70;i++)deep={x:deep};assert.throws(()=>compareRequestPrefix({messages:[],deep},request()));
});
test("node/container limits and non-JSON types fail; inputs remain unchanged",()=>{
 for(const bad of [new Date(),{messages:[],x:1n},{messages:[],x:new Array(3)},{messages:[],x:Array(10_001).fill(0)},{messages:[],x:Array.from({length:10_000},()=>Array(10).fill(0))}]) assert.throws(()=>compareRequestPrefix(bad,request()),/prefix comparison/);
 const previous=request();const snapshot=JSON.stringify(previous);
 const reordered={messages:previous.messages,system:previous.system,model:previous.model};
 assert.equal(compareRequestPrefix(previous,reordered).relation,"exact");assert.equal(JSON.stringify(previous),snapshot);
 const secretKey={...previous,["secret".repeat(100)]:true};assert.equal(compareRequestPrefix(previous,secretKey).firstChangedPath,"$.settings");
});

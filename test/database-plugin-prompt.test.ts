import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDatabasePluginWorldbookEntries as select, databasePluginWorldbookParts as parts, insertDatabasePluginDepthEntries as insert, placeDatabasePluginCharacterEntries as characterSlots } from '../src/stage/database-plugin-prompt.ts';
const entry = (content: string, extra: Record<string,unknown> = {}) => ({content, enabled:true, position:'at_depth_as_system',depth:2,type:'keyword',...extra});
test('native database: selected AM codes come only from intercepted input/normal scan, never disabled index', () => {
 const entries = [entry('DISABLED_OVERVIEW AM0001 AM0002',{enabled:false,type:'constant',comment:'纪要索引'}),entry('selected memory',{keys:['AM0001']}),entry('unselected memory',{keys:['AM0002']}),entry('prefix must not match',{keys:['AM00010']})];
 assert.deepEqual(select(entries,[], '<本轮用户输入>继续</本轮用户输入>\n<recall>AM0001 | 1m</recall>').map(e=>e.content), ['selected memory']);
 assert.equal(select(entries, [], '继续').length, 0);
});
test('native database: preserves wrappers, exact full text, original order and original role/depth', () => {
 const long = '不能由梨园擅自切掉的原文'.repeat(2000);
 const active = select([entry('</memory>',{type:'constant',order:30}),entry(long,{keys:['AM0001'],order:20}),entry('<memory>',{type:'constant',order:10})],[], 'AM0001');
 assert.deepEqual(active.map(e=>e.content), ['<memory>',long,'</memory>']);
 const base = [{role:'user',content:[{type:'text',text:'old input'}]},{role:'assistant',content:[{type:'text',text:'old reply'}]},{role:'user',content:[{type:'text',text:'native final input\n<recall>AM0001</recall>'}]}];
 const result:any[] = insert(base,parts(active).depthEntries);
 assert.deepEqual(base.map(x=>x.role), ['user','assistant','user']);
 assert.equal(result[1].role,'system');assert.equal(result[1].content[0].text,'<memory>\n\n'+long+'\n\n</memory>');
 assert.deepEqual(result.at(-1),base.at(-1));
});
test('native database: ordinary keyword recursion obeys prevention and exclusion, not table-specific expansion', () => {
 const entries=[entry('chain-key',{type:'constant',prevent_recursion:false}),entry('ordinary-key',{keys:['chain-key'],prevent_recursion:true}),entry('not chained',{keys:['ordinary-key']}),entry('excluded',{keys:['chain-key'],exclude_recursion:true})];
 assert.deepEqual(select(entries,[], 'plain input').map(e=>e.content), ['chain-key','ordinary-key']);
});
test('native database: before/after character contents respect original preset markers', () => {
 const pieces=[{source:'block',id:'start',text:'preset bytes'},{source:'marker',id:'worldInfoBefore',text:'original worldbook'},{source:'marker',id:'charDescription',text:'original card'},{source:'marker',id:'scenario',text:'original scene'},{source:'block',id:'end',text:'end bytes'}];
 const result=characterSlots(pieces,{before:'native before',after:'native after'});
 assert.deepEqual(result.presetBefore,['preset bytes','original worldbook\n\nnative before','original card','original scene','native after','end bytes']);
 assert.deepEqual(result.remaining,{before:'',after:''});assert.equal(pieces[1].text,'original worldbook');
});
test('native database: depth zero may follow user input and deep groups count original messages only', () => {
 const base=[{role:'user',content:[{type:'text',text:'user'}]},{role:'assistant',content:[{type:'text',text:'reply'}]},{role:'user',content:[{type:'text',text:'input'}]}];
 const result:any[]=insert(base,[entry('deep',{depth:2,type:'constant'}),entry('tail',{depth:0,type:'constant'}),entry('first',{depth:10000,type:'constant'})]);
 assert.deepEqual(result.map(x=>x.content[0].text),['first','user','deep','reply','input','tail']);
 assert.throws(()=>parts([entry('unsupported',{position:'own-best-location'})]),/拒绝擅自改位/);
});

test('native database: depths larger than history preserve native descending-depth grouping, not raw entry iteration order', () => {
 const base=[{role:'user',content:[{type:'text',text:'input'}]}];
 const result:any[]=insert(base,[entry('depth999',{depth:999,type:'constant',order:1}),entry('depth1000',{depth:1000,type:'constant',order:2})]);
 assert.deepEqual(result.map(x=>x.content[0].text), ['depth1000','depth999','input']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {displayName,displayText,displayRecord} from '../display-labels.js';
test('aliases only identity labels, preserving stable keys and machine references',()=>{
 assert.equal(displayName('tab'),'tobi');assert.equal(displayName('instinct'),'inna');
 assert.equal(displayText('Tab asked Instinct'), 'tobi asked inna');
 assert.equal(displayText('https://example.com/Tab `Tab` AGENT_TOKEN_INSTINCT tab-key Instinct'), 'https://example.com/Tab `Tab` AGENT_TOKEN_INSTINCT tab-key inna');
 const old={id:'tab',name:'Tab',agent:'instinct',handle:'tab',title:'Tab to Instinct',quote:'Tab said yes',link:'https://example.com/Tab',children:[{id:'instinct',name:'Instinct'}]};
 const copy=structuredClone(old),out=displayRecord(old);
 assert.deepEqual(old,copy);assert.equal(out.name,'tobi');assert.equal(out.title,'tobi to inna');
 assert.equal(out.agent,'instinct');assert.equal(out.handle,'tab');assert.equal(out.quote,old.quote);assert.equal(out.link,old.link);assert.equal(out.children[0].name,'inna');
});

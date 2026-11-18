import {EventEmitter} from 'node:events';
import {expect,it,vi} from 'vitest';
vi.mock('electron',()=>({app:{userAgentFallback:'Chrome/150 Electron/44'},session:{},webContents:{},shell:{openExternal:vi.fn()}}));
import {readFileSync} from 'node:fs';
import {RustPolicy} from '../../app/core/security/rustPolicy';
import {SessionManager} from '../../electron/sessions';
import {DEFAULT_SETTINGS} from '../../app/core/settings';
it('blocks same-site and cross-site popup windows without replacing the player, and guards HTTP redirects',()=>{
 let handler:(details:unknown)=>unknown=()=>null;
 const guest=Object.assign(new EventEmitter(),{id:1,setWindowOpenHandler:vi.fn(fn=>handler=fn),loadURL:vi.fn(),isDestroyed:()=>false});
 const countPopup=vi.fn();const source={id:'stream-test',name:'Fixture',host:'stream.test',url:'https://stream.test',kind:'web'};
 const registry={list:()=>[source]};const blocker={countPopup};
 const manager=new SessionManager(registry as never,blocker as never,{} as never,()=>DEFAULT_SETTINGS,vi.fn(),vi.fn(),new RustPolicy(readFileSync('dist/electron/security.wasm')));
 manager.manageGuest(guest as never,source as never);
 expect(handler({url:'https://stream.test/ad',disposition:'foreground-tab'})).toEqual({action:'deny'});
 expect(handler({url:'https://advert.test',disposition:'background-tab'})).toEqual({action:'deny'});
 expect(guest.loadURL).not.toHaveBeenCalled();expect(countPopup).toHaveBeenCalledTimes(2);
 const event={preventDefault:vi.fn()};
 guest.emit('will-redirect',event,'https://advert.test',false,true);expect(event.preventDefault).toHaveBeenCalledTimes(1);
 guest.emit('will-redirect',event,'https://cdn.test/frame',false,false);expect(event.preventDefault).toHaveBeenCalledTimes(1);
 guest.emit('will-navigate',event,'https://stream.test/episode-2');expect(event.preventDefault).toHaveBeenCalledTimes(1);
});

it('hands a configured main-frame redirect to its own session while still cancelling the guest navigation',()=>{
 const source={id:'old',name:'Origin',url:'https://old.test',kind:'web',enabled:true};
 const target={id:'new',name:'Destination',url:'https://new.test',kind:'web',enabled:true};
 const guest=Object.assign(new EventEmitter(),{id:2,setWindowOpenHandler:vi.fn()});
 const notify=vi.fn();
 const navigationBlocked=vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
 const registry={list:()=>[source,target]};
 const manager=new SessionManager(registry as never,{countPopup:vi.fn()} as never,{} as never,()=>DEFAULT_SETTINGS,
  notify,vi.fn(),new RustPolicy(readFileSync('dist/electron/security.wasm')),()=>false,navigationBlocked);
 manager.manageGuest(guest as never,source as never);
 const event={preventDefault:vi.fn()};
 guest.emit('will-redirect',event,'https://new.test/watch/2',false,false);
 expect(event.preventDefault).not.toHaveBeenCalled();
 guest.emit('will-redirect',event,'https://new.test/watch/2',false,true);
 expect(event.preventDefault).toHaveBeenCalledTimes(1);
 expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({sourceId:'old',destinationSourceId:'new'}));
 guest.emit('will-redirect',event,'https://new.test/watch/2',false,true);
 expect(event.preventDefault).toHaveBeenCalledTimes(2);
 expect(notify).toHaveBeenCalledTimes(1);
 expect(navigationBlocked).toHaveBeenLastCalledWith(guest,'new');
});

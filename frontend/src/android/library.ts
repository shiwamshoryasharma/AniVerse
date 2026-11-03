import { z } from 'zod';
import type { ContinueItem, FavouriteEntry, HistoryEntry, LibraryEntry, ListStatus, MediaLibraryState, MediaSnapshot, PrivacyState, ProgressEntry, ProgressSave } from '../../../app/shared/types';

const mediaSchema = z.object({ id: z.number().int().positive(), idMal: z.number().int().positive().nullable(), title: z.string().max(1000), cover: z.string().max(4096), banner: z.string().max(4096).nullable(), format: z.enum(['TV','TV_SHORT','MOVIE','SPECIAL','OVA','ONA','MUSIC']).nullable(), episodes: z.number().int().nonnegative().nullable() });
const statusSchema = z.enum(['CURRENT','PLANNING','COMPLETED','PAUSED','DROPPED','REPEATING']);
const finite = z.number().finite().nonnegative();
const progressSchema = z.object({ mediaId: z.number().int().positive(), episode: z.number().int().positive(), position: finite, duration: finite, completed: z.boolean(), sourceId: z.string().max(300).nullable(), updatedAt: finite });
const dataSchema = z.object({ version: z.literal(1), media: z.array(mediaSchema).max(3000), progress: z.array(progressSchema).max(30000), history: z.array(z.object({ id: z.number().int().positive(), media: mediaSchema, episode: z.number().int().positive(), sourceId: z.string().max(300).nullable(), position: finite, duration: finite, watchedAt: finite })).max(1000), entries: z.array(z.object({ media: mediaSchema, status: statusSchema, progress: finite, score: z.number().min(0).max(10).nullable(), updatedAt: finite })).max(3000), favourites: z.array(z.object({media:mediaSchema,addedAt:finite})).max(3000), dismissed: z.record(z.string(),finite), nextId: z.number().int().positive() });
type Data = z.infer<typeof dataSchema>;
const safeSeconds = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Trusted UI library shared by tablet screens; source WebViews never receive this interface. */
export class TabletLibrary {
  private data: Data;
  private privacy: PrivacyState = { incognito: false, privateMediaIds: [] };
  constructor(saved?: unknown, private now: () => number = () => Math.floor(Date.now()/1000)) {
    const parsed = dataSchema.safeParse(saved);
    if(!parsed.success&&saved&&typeof saved==='object'&&!Array.isArray(saved)&&'version' in saved)throw new Error('This saved library is damaged or belongs to a newer version. Its stored data has been retained.');
    this.data = parsed.success ? parsed.data : { version:1,media:[],progress:[],history:[],entries:[],favourites:[],dismissed:{},nextId:1 };
  }
  setPrivacy(privacy: PrivacyState) { this.privacy = { incognito: privacy.incognito, privateMediaIds: [...privacy.privateMediaIds] }; }
  private blocked(id: number) { return this.privacy.incognito || this.privacy.privateMediaIds.includes(id); }
  private remember(media: MediaSnapshot) { mediaSchema.parse(media); this.data.media = this.data.media.filter(row => row.id !== media.id); this.data.media.push(clone(media)); }
  exportData(): Data { return clone(this.data); }
  state(mediaId: number): MediaLibraryState {
    return clone({ favourite: this.data.favourites.some(row=>row.media.id===mediaId), entry: this.data.entries.find(row=>row.media.id===mediaId) ?? null, progress: this.data.progress.filter(row=>row.mediaId===mediaId).sort((a,b)=>a.episode-b.episode), pinned:{} });
  }
  saveProgress(input: ProgressSave): { completedNow: boolean } {
    if(this.blocked(input.media.id)) return { completedNow:false };
    if(!Number.isInteger(input.episode)||input.episode<1) throw new Error('Choose a valid episode.');
    this.remember(input.media);
    const position=safeSeconds(input.position),duration=safeSeconds(input.duration),at=this.now();
    const previous=this.data.progress.find(row=>row.mediaId===input.media.id&&row.episode===input.episode);
    const completed=!!previous?.completed || (duration>0&&position/duration>=.9);
    this.data.progress=this.data.progress.filter(row=>row.mediaId!==input.media.id||row.episode!==input.episode);
    this.data.progress.push({mediaId:input.media.id,episode:input.episode,position,duration,completed,sourceId:input.sourceId,updatedAt:at});
    const prior=this.data.history.find(row=>row.media.id===input.media.id&&row.episode===input.episode);
    this.data.history=this.data.history.filter(row=>row.media.id!==input.media.id||row.episode!==input.episode);
    this.data.history.push({id:prior?.id??this.data.nextId++,media:clone(input.media),episode:input.episode,position,duration,sourceId:input.sourceId,watchedAt:at});
    this.data.history=this.data.history.sort((a,b)=>b.watchedAt-a.watchedAt||b.id-a.id).slice(0,1000);
    let entry=this.data.entries.find(row=>row.media.id===input.media.id);
    if(!entry){entry={media:clone(input.media),status:'CURRENT',progress:0,score:null,updatedAt:at};this.data.entries.push(entry);}
    entry.media=clone(input.media);entry.updatedAt=at;
    if(completed){entry.progress=Math.max(entry.progress,input.episode);if(input.media.episodes&&entry.progress>=input.media.episodes)entry.status='COMPLETED';}
    return {completedNow:completed&&!previous?.completed};
  }
  history(limit=200,offset=0): HistoryEntry[] { return clone(this.data.history.filter(row=>!this.blocked(row.media.id)).sort((a,b)=>b.watchedAt-a.watchedAt||b.id-a.id).slice(Math.max(0,offset),Math.max(0,offset)+Math.max(0,Math.min(200,limit)))); }
  clearHistory(id: number|null) {
    if(this.privacy.incognito)return;
    const selected=id===null?this.data.history:this.data.history.filter(row=>row.id===id);
    for(const row of selected)this.data.dismissed[String(row.media.id)]=this.now();
    this.data.history=id===null?[]:this.data.history.filter(row=>row.id!==id);
  }
  dismissContinue(mediaId:number) { if(!this.blocked(mediaId))this.data.dismissed[String(mediaId)]=this.now(); }
  continueWatching(): ContinueItem[] {
    const latest=new Map<number,ProgressEntry>();
    for(const row of this.data.progress){if(this.blocked(row.mediaId)||row.updatedAt<=(this.data.dismissed[String(row.mediaId)]??-1))continue;const prior=latest.get(row.mediaId);if(!prior||row.updatedAt>prior.updatedAt||(row.updatedAt===prior.updatedAt&&row.episode>prior.episode))latest.set(row.mediaId,row);}
    return clone([...latest.values()].sort((a,b)=>b.updatedAt-a.updatedAt).flatMap(row=>{
      const media=this.data.media.find(media=>media.id===row.mediaId);if(!media)return [];
      if(row.completed&&media.episodes&&row.episode>=media.episodes)return [];
      return [{media,episode:row.episode+(row.completed?1:0),position:row.completed?0:row.position,duration:row.completed?0:row.duration,sourceId:row.sourceId,updatedAt:row.updatedAt,completed:false}];
    }));
  }
  toggleFavourite(media:MediaSnapshot):{favourite:boolean} {
    const exists=this.data.favourites.some(row=>row.media.id===media.id);if(this.blocked(media.id))return {favourite:exists};
    this.remember(media);this.data.favourites=this.data.favourites.filter(row=>row.media.id!==media.id);if(!exists)this.data.favourites.push({media:clone(media),addedAt:this.now()});return {favourite:!exists};
  }
  favourites(): FavouriteEntry[] { return clone(this.data.favourites.filter(row=>!this.blocked(row.media.id)).sort((a,b)=>b.addedAt-a.addedAt)); }
  entries(status:ListStatus|null): LibraryEntry[] { return clone(this.data.entries.filter(row=>!this.blocked(row.media.id)&&(!status||row.status===status)).sort((a,b)=>b.updatedAt-a.updatedAt)); }
  setStatus(media:MediaSnapshot,status:ListStatus|null) {
    if(this.blocked(media.id))return;this.remember(media);if(status!==null)statusSchema.parse(status);
    const prior=this.data.entries.find(row=>row.media.id===media.id);this.data.entries=this.data.entries.filter(row=>row.media.id!==media.id);
    if(status)this.data.entries.push({media:clone(media),status,score:prior?.score??null,progress:prior?.progress??0,updatedAt:this.now()});
  }
  setScore(media:MediaSnapshot,score:number|null) {
    if(this.blocked(media.id))return;if(score!==null&&(!Number.isFinite(score)||score<0||score>10))throw new Error('Score must be between 0 and 10.');
    const entry=this.data.entries.find(row=>row.media.id===media.id);if(!entry)throw new Error('Add this title to a list first.');entry.score=score;entry.updatedAt=this.now();
  }
  markWatched(media:MediaSnapshot,episode:number,watched:boolean) {
    if(this.blocked(media.id))return;
    const prior=this.data.progress.find(row=>row.mediaId===media.id&&row.episode===episode);
    if(!prior){this.saveProgress({media,episode,position:watched?1:0,duration:1,sourceId:null});}
    const row=this.data.progress.find(row=>row.mediaId===media.id&&row.episode===episode)!;row.completed=watched;
    const entry=this.data.entries.find(row=>row.media.id===media.id);if(entry){entry.progress=Math.max(0,...this.data.progress.filter(row=>row.mediaId===media.id&&row.completed).map(row=>row.episode));if(!watched&&entry.status==='COMPLETED')entry.status='CURRENT';entry.updatedAt=this.now();}
  }
}

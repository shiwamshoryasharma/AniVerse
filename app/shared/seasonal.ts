export function seasonalVisuals(now:Date,accent:string):boolean {
 return accent==='festival'&&now.getTime()>=new Date(2026,9,30).getTime()&&now.getTime()<new Date(2027,0,1).getTime();
}

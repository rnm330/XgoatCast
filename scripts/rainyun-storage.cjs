const fs=require('node:fs'),crypto=require('node:crypto');
const {S3Client,HeadBucketCommand,HeadObjectCommand,PutObjectCommand}=require('@aws-sdk/client-s3');
function httpsBase(value,label){
  let url;try{url=new URL(value);}catch{throw Error(`${label} 必须为 HTTPS 地址`);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error(`${label} 必须为不含凭据的 HTTPS 地址`);
  return url;
}
class RainyunStorage {
  constructor(env,client,fetcher=fetch){
    this.endpoint=httpsBase(env.S3_ENDPOINT,'S3_ENDPOINT');
    this.bucket=env.S3_BUCKET;
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(this.bucket||''))throw Error('请配置合法的 S3_BUCKET 桶名');
    this.prefix=(env.S3_PREFIX||'downloads/windows/official').replace(/^\/+|\/+$/g,'');
    if(!/^[A-Za-z0-9/_-]+$/.test(this.prefix)||this.prefix.split('/').some(x=>!x))throw Error('S3_PREFIX 无效');
    this.publicBase=httpsBase(env.S3_PUBLIC_BASE_URL||`${this.endpoint.href.replace(/\/$/,'')}/${this.bucket}`,'S3_PUBLIC_BASE_URL');
    if(!client&&(!env.S3_ACCESS_KEY_ID||!env.S3_SECRET_ACCESS_KEY))throw Error('请配置 S3_ACCESS_KEY_ID 和 S3_SECRET_ACCESS_KEY');
    this.client=client||new S3Client({endpoint:this.endpoint.href,region:env.S3_REGION||'rainyun',forcePathStyle:true,
      credentials:{accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY},
      requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:1});
    this.fetch=fetcher;
  }
  async checkLogin(){await this.client.send(new HeadBucketCommand({Bucket:this.bucket}));return {loginVerified:true,provider:'rainyun',bucket:this.bucket,endpoint:this.endpoint.origin};}
  async head(key){
    try{return await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}));}
    catch(error){if(error.$metadata?.httpStatusCode===404||['NotFound','NoSuchKey'].includes(error.name))return null;throw error;}
  }
  async publishFile({file,version,name,checksum}){
    const key=`${this.prefix}/${version}/${name}`,bytes=fs.statSync(file).size;
    const matches=v=>v&&Number(v.ContentLength)===bytes&&v.Metadata?.sha256===checksum;
    let stored=await this.head(key);
    if(stored&&!matches(stored))throw Error('对象存储已有不同内容的同名安装包，请递增版本号');
    if(!stored){
      // Upload once. A lost response is reconciled by HEAD on the next invocation.
      try{await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:fs.createReadStream(file),ContentLength:bytes,
        ContentType:'application/vnd.microsoft.portable-executable',ContentDisposition:`attachment; filename="${name}"`,
        ContentMD5:await md5(file),CacheControl:'public, max-age=31536000, immutable',Metadata:{sha256:checksum},IfNoneMatch:'*'}));}
      catch(error){if(error.$metadata?.httpStatusCode!==412)throw error;}
      stored=await this.head(key);
      if(!matches(stored))throw Error('对象存储未确认安装包大小与校验值，发布清单未更新');
    }
    const url=this.publicBase.href.replace(/\/$/,'')+'/'+key.split('/').map(encodeURIComponent).join('/');
    const response=await this.fetch(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok||Number(response.headers.get('content-length'))!==bytes)throw Error('安装包尚不能匿名公开下载，请检查实例及存储桶的公共访问设置；发布清单未更新');
    return {provider:'rainyun',downloadUrl:url,bucket:this.bucket,key,bytes,sha256:checksum};
  }
}
async function md5(file){const hash=crypto.createHash('md5');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('base64');}
module.exports={RainyunStorage,httpsBase};

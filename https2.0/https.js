'use strict';

const fs = require('fs');
const yargs = require('yargs');
const http = require('./http');
const pathUtil = require('path');

const argv = yargs.usage('node https.js [-v verbose][-p port] [-d Path-to-directory]')
    .default('p', 8080)
    .default('d', ".")
    .default('v', false)
    .help('help')
    .argv;

function Logger(){
    Logger.prototype.log = (!argv.v ? function(){} : function(message){
        console.log(message);
    });
};

var savedLog = console.log;
console.log = function(msg){
    if(argv.v){
        savedLog.call(this, msg);
    }
}
var logger = new Logger();

var httpServer = new http(argv.p,
    // GET Handler
    function(request){
        var path = pathUtil.normalize('./'+request.split(' ')[1]);
        //   Can't resquest files outside directory'
        if(validPath(path)){
            var stat;
            try{
                stat = fs.statSync(argv.d+'/'+path);
            }catch(err){
                logger.log("Request not found: Sending 404");
                return this.sendReply("404");
            }
            if(stat){
                var content;
                if(stat.isFile())
                    content = fs.readFileSync(path).toString();
                else if(stat.isDirectory())
                    content = fs.readdirSync(path);
                return this.sendReply("200", content, path);
            }else{
                logger.log("Request not found: Sending 404");
                return this.sendReply("404");
            }
        }else{
            logger.log("Client trying to access invalid location: Sending 403");
            return this.sendReply("403");
        }
    },
    // POST Handler
    function(request){
        console.log(request);
        var path = pathUtil.normalize('/.'+request.split(' ')[1]);
        if(validPath(path)){
            var body = request.split('\r\n\r\n');
            body.splice(0,1);
            body =  body.join('\n');
            fs.writeFileSync(argv.d+'/'+path, request);
            var tmp = path.split('/');
            var pathDir = tmp.slice(0, tmp.length-1).join('/');
            console.log(pathDir);
            var dir = fs.readdirSync(pathUtil.resolve(argv.d+'/'+path, '..'));
            return this.sendReply("201", dir);
        }else{
            return this.sendReply("403");
        }
    }, logger);

    function validPath(path){
        console.log(path)
        return (path.includes("..") ? false : true);
    }
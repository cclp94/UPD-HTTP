   'use strict';

const dgram = require('dgram');
const socket = dgram.createSocket('udp4');
const Packet = require('..//Packet');
const url = require('url');
const pjson = require('./package.json');

var sequenceFollower = 0;
const router = 'http://localhost:3000';
var queue = [];
var connectionStarted = false;
var httpReply;
var closingConnection = false;

const statusCode = {
    200   : {
                message: "OK",
                body : ""
            },   
    201   : {
                message: "Created",
                body : `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>201 Created</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>All Good! resource was created</h1>
                        </body>
                        </html>`
            },
    400   : {
                message: "Bad Request",
                body : ""
            },
    403   : {
                message: "Forbidden",
                body : `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>403 Forbidden</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>Access Forbidden</h1>
                            <p>Sorry, you do not have access to this resource.</p>
                        </body>
                        </html>`
            },
    404   : {
                message: "Not Found",
                body : `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>Page Not Found</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>Page Not Found</h1>
                            <p>Sorry, but the page you were trying to view does not exist.</p>
                        </body>
                        </html>`
    },
    500   : {
   message: "Internal Server Error",
                body : `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>500 Server Error</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>Internal Server Error</h1>
                            <p>There was a problem with the server, try again later</p>
                        </body>
                        </html>`
            }
}

const MINE_TYPES = {
    "html": {
        ContentType : "text/html"
    },
    "json": {
        ContentType : "application/json"
    },
    "undefined": {
        ContentType : "undefined",
         ContentDisposition: "attachment"
    },
    "pdf": {
        ContentType : "application/pdf",
        ContentDisposition: "attachment"
    },
    "jpeg": {
        ContentType : "image/jpeg",
        ContentDisposition: "attachment"
    },
    "jpg": {
        ContentType : "image/jpeg",
        ContentDisposition: "attachment"
    },
    "png": {
        ContentType : "image/png",
        ContentDisposition: "attachment"
    },
   "xml": {
        ContentType : "application/xlm"
    }
}

var getDocumentType = function(code, path, body){
    if(code === "200"){
        var splitPath = path.split('/');
        var file = (splitPath[splitPath.length-1].split('.'));
        return (file[1]) ?  file[1] :  'undefined';
    }else
        return 'html';
}

function sendPacket(packet, destination){
    if(httpReply){
        packet.setPayload(httpReply);
    }
    var dest = url.parse(destination);
    console.log("Sending packet #"+packet.sequenceNumber+ "type: "+packet.type);
    socket.send(packet.getBuffer(), dest.port, dest.hostname);
}

function addToQueue(pk, expected, httpServer){
    if(queue.length === 0 || queue[queue.length-1].seq < pk.sequenceNumber){
        queue.push({
            seq : pk.sequenceNumber,
            data : pk.payload,
            address : pk.address,
            port: pk.port,
            isFIN: pk.type === 4 ? true : false
        });
        if(expected === true) sequenceFollower++;
        console.log("Queue has: "); console.log(queue);
    }else{

        for(var i = queue.length - 1; i >= 0; i--){
            if(queue[i].seq < pk.sequenceNumber || i === 0){
                queue.splice((i == 0 ? 0 : i+1), 0, {
                    seq : pk.sequenceNumber,
                    data : pk.payload
                });
                if(expected === true){
                    var lastInOrder = sequenceFollower;
                    for(var j = (i!== 0 ? i+1 : 0); j < queue.length; j++){
                        var lastInOrder = queue[j].seq;
                        if(!queue[j+1] || queue[j+1].seq - queue[j].seq > 1)
                            break;
                    }
                    sequenceFollower = lastInOrder + 1;
                    console.log("Queue has: "); console.log(queue);
                }
            }
        }
    }
    if(expected)
        checkDelivery(httpServer);
}

function checkDelivery(httpServer){
    if(queue[queue.length-1].isFIN && queue[queue.length-1].seq === sequenceFollower -1){
        console.log("Send reply");
        var packet = (new Packet()).setType(2)
                            .setAddress(queue[queue.length-1].address)
                            .setPort(queue[queue.length-1].port)
                            .setSequenceNumber(sequenceFollower)
                            .setPayload(httpReply);
        sendPacket(packet, router);
        httpServer.deliverQueue();
        closingConnection = true;
    }
}

function flush(){
    queue = [];
    sequenceFollower = 0;
    closingConnection = false;
}

function httpServer(port, get, post, logger){
    httpServer.prototype.logger = logger ? function(){this.log()= function(){}} : logger;
    httpServer.prototype.get = get ? get : function(){};
    httpServer.prototype.post = post ? post : function(){};
    var that = this;

     socket.on('listening', () => {
        var address = socket.address();
        console.log(`server listening ${address.address}:${address.port}`);
    });
    socket.on('message', (msg, rinfo) => {

        var ackSynPk = Packet.createFromBuffer(msg);
        console.log(`server got: ${ackSynPk.sequenceNumber} type ${ackSynPk.type} expecting ${sequenceFollower} and ${connectionStarted}`);
        if(ackSynPk.type === 0){
            sequenceFollower = ackSynPk.sequenceNumber+1;
            if(!connectionStarted){
                var packet = ackSynPk.copy()
                                .setType(1)
                                .setSequenceNumber(sequenceFollower);
                sendPacket(packet, router);
            }else{
                var packet = ackSynPk.copy()
                                .setType(1)
                                .setSequenceNumber(sequenceFollower);
                sendPacket(packet, router);
            }
        }else if(ackSynPk.type === 2){
            console.log("here2");
            if(ackSynPk.sequenceNumber == sequenceFollower){
                sequenceFollower++;
                console.log("Connection Change");
                connectionStarted = !connectionStarted;
                if(closingConnection){
                    clearInterval(queue[queue.length-1].timer);
                }
                if(!connectionStarted){
                    flush();
                } 
            }
        }else if(ackSynPk.type == 3 && connectionStarted){
   console.log('here3');
            if(ackSynPk.sequenceNumber == sequenceFollower){
                addToQueue(ackSynPk, true, this);
                var packet = ackSynPk.copy()
                            .setType(2)
                            .setSequenceNumber(sequenceFollower)
                            .setPayload('');
                    sendPacket(packet, router);
            }else{
                if(ackSynPk.sequenceNumber > sequenceFollower){
                    addToQueue(ackSynPk, false);
                }
                var packet = ackSynPk.copy()
                            .setType(2)
                            .setSequenceNumber(sequenceFollower)
                            .setPayload('');
                    sendPacket(packet, router);
            }
        }else if(ackSynPk.type == 4 && connectionStarted){
            if(ackSynPk.sequenceNumber === sequenceFollower){
                // Deliver & clear ordered queue
                console.log('here4');
                console.log("Send reply2");
                var packet = ackSynPk.copy()
                                    .setType(2)
                                    .setSequenceNumber(sequenceFollower)
                                    .setPayload('');
                sendPacket(packet, router);
                httpReply = this.deliverQueue();
                closingConnection = true;
            }else{
                console.log('her54');
                 console.log(`server got: ${ackSynPk.sequenceNumber} expecting ${sequenceFollower}`);
                if(ackSynPk.sequenceNumber > sequenceFollower){
                    addToQueue(ackSynPk, false);
                }
                var packet = ackSynPk.copy()
                            .setType(2)
                            .setSequenceNumber(sequenceFollower)
                            .setPayload('');
                    sendPacket(packet, router);
            }
        }
        console.log("SEQ NUMBER IS: "+sequenceFollower);
    });

    socket.bind(1234);

    httpServer.prototype.sendReply = function(socket, code, body, path){
        var status = statusCode[code];
        var docType = MINE_TYPES[getDocumentType(code, path)];
        if(!docType){
    docType = {
                ContentType : "text/plain"
            }
        }
        if(body && typeof body !== 'string')
            body = body.join('\r\n');
        // Header
        // Status
        var reply = 'HTTP/1.1 '+ code + ' ' + status.message + '\r\n'
        // General Header
        reply += 'Date: '+(new Date()).toString() +'\r\n';
        // Response Headers
        reply += 'Server: '+pjson.name + '/' + pjson.version + '\r\n';
        // Entity Header
        reply += 'Content-Type: ' + docType.ContentType + '\r\n';
        reply += docType.ContentDisposition ? 'Content-Disposition: ' + docType.ContentDisposition + '\r\n' : '';
        reply += 'Content-Length: ' + (body ? body.length + 4 : 0) + '\r\n';
        // body
        reply+= '\r\n';
        if(body){
            reply+= (typeof body === 'string' ? body : body.join('\r\n')) + '\r\n';
        }else{
            reply+= status.body + '\r\n';
        }
        // End
        reply += '\r\n';
        //Send
        logger.log("sending reply:\n");
        logger.log(reply);
        return reply;
    }

    this.deliverQueue = function(){
        console.log(queue);
        var request = queue.reduce((req, pk)=>{
            console.log(pk.data);
            return req + pk.data;
        }, '');
        console.log('Request:\n'+request + '\n');
        if(request.startsWith('GET'))
            httpReply =  that.get( socket, request);
        else if(request.startsWith('POST'))
            httpReply = that.post(socket, request);
        else
            httpReply =  that.sendReply(socket, "400");

        var packet = (new Packet()).setType(4)
                            .setAddress(queue[queue.length-1].address)
                            .setPort(queue[queue.length-1].port)
                            .setSequenceNumber(++sequenceFollower)
                            .setPayload(httpReply);

        queue.push({
            packet: packet,
            timer: setInterval(function(){
                console.log("RETRANSMIT");
                sendPacket(packet, router);
            }, 2000)
        });
        sendPacket(packet, router);
    }
}

module.exports = httpServer;
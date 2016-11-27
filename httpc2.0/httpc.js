// FOR HELP AND USAGE RUN: 'node httpc.js --help'
'use strict';

const dgram = require('dgram');
const socket = dgram.createSocket('udp4');
const Packet = require('../Packet');
const yargs = require('yargs');
const url = require('url');
const fs = require('fs');

const router = 'http://localhost:3000';
const WINDOW_SIZE = 10;

var sequenceFollower = 0;
var queue = [];


var window_buffer = [];
var sendingQueue = [];

var log = console.log;
console.log = function(msg, important){
    if(argv.v || important){
        log.call(this, msg);
    }
}

// Command Line Usage
const argv = yargs.usage('Usage: node $0 (get|post) [-v] (-h "k:v")* [-d inline-data] [-f file] URL [-o save reply to file]')
    // GET
    .command('get [-v] [-h] <URL> [-o]', 'Get executes a HTTP GET request for the given URL',
        {
            v: {
                alias: 'verbose',
                type: 'boolean',
                describe: 'shows verbose mode'
            },
            h: {
                alias: 'header',
                type: 'string',
                describe: 'set headers values for request'
            },
            URL: {
                alias: 'url',
                describe: 'The URL for the request',
                type: 'string'
            },
            o: {
                describe: 'Save Reply message to File',
                type: 'string'
            }
        }
    ). help()
    // POST
    .command('post [-v] [-h] [-d] [-f] <URL> [-o]', 'Get executes a HTTP GET request for the given URL',
        {
            v: {
                alias: 'verbose',
                type: 'boolean',
                describe: 'shows verbose mode'
            },
            h: {
                alias: 'header',
                type: 'string',
                describe: 'set headers values for request'
            },
            d: {
                alias: 'data',
                type: 'string',
                describe: 'Associates inline-data to the body HTTP POST request'
            },
            f: {
                alias: 'file',
                type: 'string',
                describe: 'Associates the content of a file to the body HTTP POST request'
            },
            URL: {
                alias: 'url',
                describe: 'The URL for the request',
                type: 'string'
            },
            o: {
                describe: 'Save Reply message to File',
                type: 'string'
            }
        }
    ). help()
    .argv;

    var parsedURL = url.parse(argv.URL);
    makeRequest(parsedURL);

    function makeRequest(parsedURL){
        var httpRequest = createHTTPMessage(argv, parsedURL);
        console.log(httpRequest);
        // Hand shake
        socket.bind({
            address: 'localhost',
            port: 8000,
            exclusive: true
        }, () =>{
            var firstPacket = (new Packet())
                    .setType(0)
                    .setSequenceNumber(0)
                    .setAddress(parsedURL.hostname)
                    .setPort(parsedURL.port)
                    .setPayload('jhkjhk');
            addToSendingQueue(firstPacket);
            var connection = false;
            socket.on('message', (msg, rinfo) => {
                var packet = Packet.createFromBuffer(msg);
                console.log(`client got: ${packet.sequenceNumber} type ${packet.type}`);
                if(packet.type == 1){             // SYN + ACK
                    connection = true;
                    removeFromWindow(packet.sequenceNumber);
                    packet = packet.setType(2)
                                    .setAddress(parsedURL.hostname)
                                    .setPort(parsedURL.port);
                    addToSendingQueue(packet);
                    // Connection estabilished
                    var seq = startTransmittion(httpRequest, packet);
                    // Send Close connection signal
                    var FINPk = packet.copy()
                                    .setType(4)
                                    .setSequenceNumber(seq)
                                    .setPayload('');
                    addToSendingQueue(FINPk);
                    sequenceFollower = seq +1;
                }else if(packet.type == 2 && connection){           // ACK
                    // Pop Cumulative ack from window
                    removeFromWindow(packet.sequenceNumber);
                }else if(packet.type == 3 && connection){      
                    if (packet.sequenceNumber == sequenceFollower)
                        addToQueue(packet, true, this);
                    else if (packet.sequenceNumber > sequenceFollower)
                        addToQueue(packet, false);
                    sendAcknowledgement(packet);
                }else if(packet.type == 4 && connection){           // FIN + ACK
                    removeFromWindow(packet.sequenceNumber);

                    if (packet.sequenceNumber > sequenceFollower &&
                        packet.sequenceNumber !== sequenceFollower)
                        addToQueue(packet, false);
                    sendAcknowledgement(packet);
                    if (packet.sequenceNumber === sequenceFollower) {
                        deliverQueue();
                    }
                    setTimeout(function(){
                        socket.close();
                    }, 2000 );
                    return;
                }else if(packet.type == 5 && connection){           // NACK
                    retransmit(packet.sequenceNumber);
                    console.log(packet.payload);
                }
            });
        });
    }

    function sendAcknowledgement(oldPk) {
        var packet = oldPk.copy()
            .setType(2)
            .setSequenceNumber(sequenceFollower)
            .setPayload('');
        sendPacket(packet, router);
    }

    function retransmit(seq){
        removeFromWindow(seq);
        sendPacket(window_buffer[0].packet, router);
    }

    function removeFromWindow(arrivedSeq){
        console.log("remove up to: " + arrivedSeq);
        console.log('window size: ' + window_buffer.length+ 'queue size: '+sendingQueue.length);
        if(window_buffer.length > 0 && arrivedSeq < window_buffer[0].seq ) return;
        console.log(window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
        var i = 0;
        while(window_buffer.length !== 0 && window_buffer[0].seq <= arrivedSeq-1){
            clearInterval(window_buffer.shift().timer);
            i++;
        }
                
        console.log(window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
        var toSend = sendingQueue.splice(0 ,i);
        for(var j in toSend){
            addToWindowAndSend(toSend[j]);
        }
        return;
    }

    function addToWindowAndSend(pk){
        window_buffer.push({
            seq : pk.sequenceNumber,
            packet : pk,
            timer: setInterval(function(){
                console.log("RETRANSMIT");
                sendPacket(pk, router);
            }, 900)
        });
        console.log('Sending '+ pk.sequenceNumber+ ' - buffer Length ' + window_buffer.length);
        sendPacket(pk, router);
    }

    function addToSendingQueue(pk){
        if(window_buffer.length < WINDOW_SIZE){
            addToWindowAndSend(pk);
        }else
            sendingQueue.push(pk);
    }

    function startTransmittion(httpRequest, lastPack){

        if(httpRequest.length > 1013){
            var packets = Math.floor(httpRequest.length/1013);
            var rest = httpRequest.length % 1013;
            console.log("Length: "+ httpRequest.length + ', packets: '+packets+ ', rest: '+rest);
            var contents = [];
            var i = 0;
            for(i = 0; i <= packets-1; i++){
                contents.push(httpRequest.substring(0 + (1013*i), 1013 + (1013*i)));
            }
            contents.push(httpRequest.substring(1013 + (1013*(packets-1))));
            httpRequest = contents;
        }
        var seq = lastPack.sequenceNumber + 1;
        if(typeof httpRequest == 'string'){
            var Pn = lastPack.copy()
                        .setType(3)
                        .setSequenceNumber(seq++)
                        .setPayload(httpRequest);

            addToSendingQueue(Pn);
        }else{
            for(var i in httpRequest){
                var Pn = lastPack.copy()
                            .setType(3)
                            .setSequenceNumber(seq++)
                            .setPayload(httpRequest[i]);

                addToSendingQueue(Pn)
            }
        }
        return seq;

    }

    function sendPacket(packet, destination){
        var dest = url.parse(destination);
        var buffer = packet.getBuffer();
        console.log("Sending packet #"+packet.sequenceNumber+ "type: "+packet.type);
        socket.send(buffer, 0, buffer.length, dest.port, dest.hostname);
    }

    // RECEIVER
    function addToQueue(pk, expected) {
    if (queue.length === 0 || queue[queue.length - 1].seq < pk.sequenceNumber) {
        queue.push({
            seq: pk.sequenceNumber,
            data: pk.payload,
            address: pk.address,
            port: pk.port,
            isFIN: pk.type === 4 ? true : false
        });
        if (expected === true) sequenceFollower++;
        console.log("1. Queue has: "); console.log(queue.reduce((result, cur) => { return result += ', ' + cur.seq }, ''));
    } else if (queue[0].seq > pk.sequenceNumber) {
        queue.unshift({
            seq: pk.sequenceNumber,
            data: pk.payload,
            address: pk.address,
            port: pk.port,
            isFIN: pk.type === 4 ? true : false
        });
        if (expected === true) {
            var lastInOrder = sequenceFollower;
            for (var j = 0; j < queue.length; j++) {
                var lastInOrder = queue[j].seq;
                if (!queue[j + 1] || queue[j + 1].seq - queue[j].seq > 1)
                    break;
            }
            sequenceFollower = lastInOrder + 1;
        }
        console.log("2. Queue has: "); console.log(queue.reduce((result, cur) => { return result += ', ' + cur.seq }, ''));

    } else {

        for (var i = queue.length - 1; i >= 0; i--) {
            if (queue[i].seq === pk.sequenceNumber) return;
            if (queue[i].seq < pk.sequenceNumber) {
                queue.splice((i + 1), 0, {
                    seq: pk.sequenceNumber,
                    data: pk.payload,
                    address: pk.address,
                    port: pk.port,
                    isFIN: pk.type === 4 ? true : false
                });
                if (expected === true) {
                    var lastInOrder = sequenceFollower;
                    for (var j = (i !== 0 ? i + 1 : 0); j < queue.length; j++) {
                        var lastInOrder = queue[j].seq;
                        if (!queue[j + 1] || queue[j + 1].seq - queue[j].seq > 1)
                            break;
                    }
                    sequenceFollower = lastInOrder + 1;
                }
                console.log("3. Queue has: "); console.log(queue.reduce((result, cur) => { return result += ', ' + cur.seq }, ''));
                break;
            }
        }
    }
    if (expected)
        checkDelivery();
}

function checkDelivery() {
    if (queue[queue.length - 1].isFIN && queue[queue.length - 1].seq === sequenceFollower - 1) {
        console.log("Send reply");
        var packet = (new Packet()).setType(2)
            .setAddress(queue[queue.length - 1].address)
            .setPort(queue[queue.length - 1].port)
            .setSequenceNumber(++sequenceFollower)
            .setPayload('');
        sendPacket(packet, router);
        deliverQueue();
        closingConnection = true;
    }
}

function deliverQueue(){
    var request = queue.reduce((req, pk) => {
            console.log(pk.data);
            return req + pk.data;
        }, '');
    console.log(request);
}


    // HTTP

    function createHTTPMessage(argv, parsedURL){
         if(argv.URL){
                var options = {
                    host: parsedURL.hostname,
                    port: parsedURL.port,
                    path: parsedURL.path,
                    method: argv._[0].toUpperCase()
                };

                setHeaders(options, argv.h);
                if(argv._[0] === 'post'){
                    var postData = getPostData(argv);
                    options.body = postData;
                }
                return (
                    options.method + ' ' + options.path + ' ' + 'HTTP/1.1\r\n'+
                    'Host: '+ options.host+'\r\n'+
                    'Port: '+options.port+'\r\n'+
                    ((options.headers) ? options.headers +'\r\n': '' )+
                    ((options.body && !options.headers.includes('Content-Length') )? 'Content-Length: ' + options.body.length +'\r\n': '')+
                    '\r\n'+
                    (options.body ? options.body +'\r\n\r\n': '\r\n')
                );
            }
    };

    function getPostData(argv){
        if(argv.d && !argv.f){
            return argv.d;
        }else if(argv.f && !argv.d){
            var fileData = fs.readFileSync(argv.f);
            return fileData.toString();
        }else{
            console.log("There is a problem with the data provided");
            process.exit();
        }
    }

     function setHeaders(options, header) {
         if(!options.headers) options.headers = '';
         if(header){
             if(typeof header == 'string'){
                 options.headers = header;
             }else{
                 options.headers = header.join('\r\n');
             }
         }
     }
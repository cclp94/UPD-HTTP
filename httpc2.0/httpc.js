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


var window_buffer = [];
var sendingQueue = [];

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
            var packet = (new Packet())
                    .setType(0)
                    .setSequenceNumber(0)
                    .setAddress(parsedURL.hostname)
                    .setPort(parsedURL.port)
                    .setPayload('jhkjhk');
            addToSendingQueue(packet);
            var connection = false;
            socket.on('message', (msg, rinfo) => {
                var ackSynPk = Packet.createFromBuffer(msg);
                console.log(`client got: ${ackSynPk.sequenceNumber} type ${ackSynPk.type}`);
                if(ackSynPk.type == 1){             // SYN + ACK
                    connection = true;
                    removeFromWindow(ackSynPk.sequenceNumber);
                    ackSynPk = ackSynPk.setType(2)
                                    .setAddress(parsedURL.hostname)
                                    .setPort(parsedURL.port);
                    addToSendingQueue(ackSynPk);
                    // Connection estabilished
                    var seq = startTransmittion(httpRequest, ackSynPk);
                    // Send Close connection signal
                    var FINPk = packet.copy()
                                    .setType(4)
                                    .setSequenceNumber(seq)
                                    .setPayload('');
                    addToSendingQueue(FINPk);

                }else if(ackSynPk.type == 2 && connection){           // ACK
                    // Pop Cumulative ack from window
                    if(ackSynPk.sequenceNumber > 0)
                        removeFromWindow(ackSynPk.sequenceNumber);
                }else if(ackSynPk.type == 4 && connection){           // FIN + ACK
                    removeFromWindow(ackSynPk.sequenceNumber);
                    console.log(ackSynPk.payload);
                    console.log("Sending last");
                    var last = ackSynPk.copy()
                                    .setType(2)
                                    .setPayload('');
                    // Send and don't add to window
                    sendPacket(last, router);
                    setTimeout(function(){
                        socket.close();
                    }, 5000 );
                    return;
                }else if(ackSynPk.type == 5 && connection){           // NACK
                    retransmit(ackSynPk.sequenceNumber);
                    console.log(ackSynPk.payload);
                }
            });
        });
    }

    function retransmit(seq){
        removeFromWindow(seq);
        sendPacket(window_buffer[0].packet, router);
    }

    function removeFromWindow(seq){
        console.log("remove up to: " + seq);
        console.log('window size: ' + window_buffer.length+ 'queue size: '+sendingQueue.length);
        if(window_buffer.length > 0 && seq < window_buffer[0].seq ) return;
        console.log(window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
        for(var i in window_buffer){
            if(window_buffer[i].seq <= seq-1){
                clearInterval(window_buffer[i].timer);
                console.log(window_buffer[i].seq + " cleared");
            }
            if(window_buffer[i].seq === seq-1){
                console.log('here');
                console.log('Before splice: '+window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
                window_buffer.splice(0, i+1);
                console.log('Window now: '+window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
                var toSend = sendingQueue.splice(0 ,i+1);
                for(var j in toSend){
                    addToWindowAndSend(toSend[j]);
                }
                return;
            }
        }
    }

    function addToWindowAndSend(pk){
        window_buffer.push({
            seq : pk.sequenceNumber,
            packet : pk,
            timer: setInterval(function(){
                console.log("RETRANSMIT");
                sendPacket(pk, router);
            }, 2000)
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
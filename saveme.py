import os

lines = [line.rstrip('\n') for line in open('blob')]

for val in lines:
    os.system('git cat-file -p '+val)
    os.system("pause")


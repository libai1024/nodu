# SPDX-License-Identifier: MIT
from unittest.mock import patch
import importlib.util,unittest,tempfile,pathlib,tarfile,io,hashlib,json
spec=importlib.util.spec_from_file_location('prepare',pathlib.Path(__file__).with_name('prepare-tutor-tools.py'));prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepare)
class Boundaries(unittest.TestCase):
    def test_archive_digest_and_offline(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);p=root/'asset.tar.gz';p.write_bytes(b'abc')
            asset={'name':p.name,'size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
            self.assertEqual(prepare.archive(asset,root,True),p)
            p.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'SHA256'):prepare.archive(asset,root,True)
            p.unlink()
            with self.assertRaisesRegex(ValueError,'missing'):prepare.archive(asset,root,True)
    def test_paths_links_and_special_files_before_extraction(self):
        for name,kind,link in [('../escape','file',''),('/absolute','file',''),('other/file','file',''),('sdk/link','link','../../escape'),('sdk/fifo','fifo','')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temp:
                root=pathlib.Path(temp);archive=root/'bad.tar';dest=root/'extract';dest.mkdir()
                with tarfile.open(archive,'w') as t:
                    m=tarfile.TarInfo(name)
                    if kind=='link':m.type=tarfile.SYMTYPE;m.linkname=link
                    if kind=='fifo':m.type=tarfile.FIFOTYPE
                    t.addfile(m,io.BytesIO())
                with self.assertRaises(ValueError):prepare.extract(archive,dest,'sdk')
                self.assertEqual(list(dest.iterdir()),[])
    def test_internal_link_and_existing_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);dest=root/'extract';dest.mkdir();archive=root/'good.tar'
            with tarfile.open(archive,'w') as t:
                m=tarfile.TarInfo('sdk/bin/clang-23');m.size=3;t.addfile(m,io.BytesIO(b'abc'))
                m=tarfile.TarInfo('sdk/bin/clang');m.type=tarfile.SYMTYPE;m.linkname='clang-23';t.addfile(m)
            prepare.extract(archive,dest,'sdk');prepare.copy_inside(dest/'sdk','bin/clang',root/'copy')
            self.assertEqual((root/'copy').read_bytes(),b'abc');self.assertFalse((root/'copy').is_symlink())
            with self.assertRaisesRegex(ValueError,'Destination exists'):prepare.prepare('darwin-arm64',root,dest,True)
    def test_installed_license_inputs_must_match_current_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);out=root/'installed';out.mkdir()
            sources=root/'scope-extension/resources/licenses/tutor-wasi';sources.mkdir(parents=True)
            names=['WASI-SDK-LICENSE','LLVM-LICENSE','Libedit-COPYING','Wasmtime-LICENSE','SOURCES.json']
            paths=['sdk/bin/clang','sdk/bin/wasm-ld','runtime/wasmtime']+['licenses/'+name for name in names]
            files=[]
            for relative in paths:
                p=out/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'fixture')
                files.append({'path':relative,'size':7,'sha256':prepare.digest(p)})
            for name in names:(sources/name).write_bytes(b'fixture')
            target='darwin-arm64'
            manifest={'schema':1,'version':prepare.LOCK['version'],'platform':target,'archives':prepare.LOCK['platforms'][target],'files':files,'totalBytes':7*len(files)}
            (out/'toolkit.json').write_text(json.dumps(manifest))
            desktop=prepare.DESKTOP;prepare.DESKTOP=root
            try:
                self.assertEqual(prepare.verify_existing(out,target)['totalBytes'],7*len(files))
                (sources/'SOURCES.json').write_bytes(b'updated provenance')
                with self.assertRaisesRegex(ValueError,'license material is stale'):prepare.verify_existing(out,target)
                self.assertEqual((out/'licenses/SOURCES.json').read_bytes(),b'fixture')
            finally:prepare.DESKTOP=desktop
    def test_platform_specific_components_and_missing_arm64_dependency(self):
        for target,missing in [('darwin-x64',False),('darwin-arm64',False),('darwin-arm64',True)]:
            with self.subTest(target=target,missing=missing),tempfile.TemporaryDirectory() as temp:
                root=pathlib.Path(temp);out=root/'installed'
                def unpack(file,destination,folder):
                    package=destination/folder
                    if 'wasi-sdk' in folder:
                        paths=[source for source,_ in prepare.sdk_components(target)]
                        if missing: paths.remove('lib/libedit.0.dylib')
                    else: paths=['wasmtime','LICENSE']
                    for relative in paths:
                        p=package/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'fixture')
                with patch.object(prepare,'archive',return_value=root/'fixture'),patch.object(prepare,'extract',side_effect=unpack):
                    if missing:
                        with self.assertRaisesRegex(ValueError,'libedit'):prepare.prepare(target,root,out,True)
                        self.assertFalse(out.exists())
                    else:
                        manifest=prepare.prepare(target,root,out,True)
                        self.assertEqual('sdk/lib/libedit.0.dylib' in [f['path'] for f in manifest['files']],target=='darwin-arm64')
                        self.assertEqual(prepare.verify_existing(out,target),manifest)

if __name__=='__main__':unittest.main()
